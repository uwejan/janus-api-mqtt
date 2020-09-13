const PahoMQTT = require('paho-mqtt')
const JanusPlugin = require('./JanusPlugin')
const { v4: uuid } = require('uuid')

const ignoredErrorCodes = [
  458, // JANUS_ERROR_SESSION_NOT_FOUND
  459 // JANUS_ERROR_HANDLE_NOT_FOUND
]
// var promiseResolve, promiseReject
class JanusMqtt {
  constructor (config, logger, mit) {
    this.config = config
    this.logger = logger
    this.mit = mit
    this.mqttClient = null
    this.isConnected = false
    this.sessionId = undefined
    this.transactions = {}
    this.pluginHandles = {}
    this.sendCreate = true
  }

  connect (client) {
    if (client) { //  Used as an already client passed as an argument to connect method, it assumes you already sub to janus topic
      this.mit.on(this.config.gotMessage, (message) => this.onMessage(message))
      this.mit.on(this.config.gotDown, this.cleanup)

      this.mqttClient = client

      if (this.isConnected) {
        return Promise.resolve(this)
      }
      return new Promise((resolve, reject) => {
        if (!this.sendCreate) {
          this.isConnected = true
          this.keepAlive(true)
          return resolve(this)
        }
        const transaction = uuid()
        const request = { janus: 'create', transaction }
        this.mqttClient.publish(this.config.pubTopic, JSON.stringify(request).toString())
        this.transactions[transaction] = {
          resolve: (json) => {
            if (json.janus !== 'success') {
              this.logger.error('Cannot connect to Janus', json)
              reject(json)
              return
            }
            this.sessionId = json.data.id
            this.isConnected = true
            this.keepAlive(true)
            this.logger.debug('Janus connected, sessionId: ', this.sessionId)
            resolve(this)
          },
          reject,
          replyType: 'success'
        }
      })
    } if (!client) {
      if (this.isConnected) {
        return Promise.resolve(this)
      }

      return new Promise((resolve, reject) => {
        this.mqttClient = new PahoMQTT.Client(this.config.url, this.config.port, this.config.clientId)
        this.mqttClient.onMessageArrived = (message) => { this.onMessage(message.payloadString) }
        this.mqttClient.onConnectionLost = (responseObject) => {
          this.onClose()
          this.cleanup()
          this.logger.error('Error connecting to the Janus WebSockets server...', +responseObject)
          this.isConnected = false
        }
        this.mqttClient.onConnected = () => {
          if (!this.sendCreate) {
            this.isConnected = true
            this.keepAlive(true)
            return resolve(this)
          }
          this.mqttClient.subscribe(this.config.subTopic)
          const transaction = uuid()
          const request = { janus: 'create', transaction }

          this.transactions[transaction] = {
            resolve: (json) => {
              if (json.janus !== 'success') {
                this.logger.error('Cannot connect to Janus', json)
                reject(json)
                return
              }

              this.sessionId = json.data.id
              this.isConnected = true
              this.keepAlive(true)

              this.logger.debug('Janus connected, sessionId: ', this.sessionId)

              resolve(this)
            },
            reject,
            replyType: 'success'
          }
          this.mqttClient.publish(this.config.pubTopic, JSON.stringify(request).toString())
        }
        this.mqttClient.connect({
          userName: this.config.userName,
          password: this.config.password,
          useSSL: true,
          keepAliveInterval: this.config.keepAliveInterval
        })
      })
    }
  }

  /**
     *
     * @param {JanusPlugin} plugin
     * @return {Promise}
     * */
  addPlugin (plugin) {
    if (!(plugin instanceof JanusPlugin)) {
      return Promise.reject(new Error('plugin is not a JanusPlugin'))
    }

    const request = plugin.getAttachPayload()

    return this.transaction('attach', request, 'success').then((json) => {
      if (json.janus !== 'success') {
        this.logger.error('Cannot add plugin', json)
        plugin.error(json)
        throw new Error(json)
      }

      this.pluginHandles[json.data.id] = plugin

      return plugin.success(this, json.data.id)
    })
  }

  transaction (type, payload, replyType, timeoutMs) {
    if (!replyType) {
      replyType = 'ack'
    }
    const transactionId = uuid()

    return new Promise((resolve, reject) => {
      if (timeoutMs) {
        setTimeout(() => {
          reject(new Error('Transaction timed out after ' + timeoutMs + ' ms'))
        }, timeoutMs)
      }

      if (!this.isConnected) {
        reject(new Error('Janus is not connected'))
        return
      }

      const request = Object.assign({}, payload, {
        janus: type,
        session_id: (payload && parseInt(payload.session_id, 10)) || this.sessionId,
        transaction: transactionId
      })

      this.transactions[request.transaction] = { resolve, reject, replyType, request }
      this.mqttClient.publish(this.config.pubTopic, JSON.stringify(request))
    })
  }

  send (type, payload) {
    return new Promise((resolve, reject) => {
      if (!this.isConnected) {
        reject(new Error('Janus is not connected'))
        return
      }

      const request = Object.assign({}, payload, {
        janus: type,
        session_id: this.sessionId,
        transaction: uuid()
      })

      this.logger.debug('Janus sending', request)
      this.mqttClient.publish(this.config.pubTopic, JSON.stringify(request), {}, (err) => {
        if (err) {
          reject(err)
        } else {
          resolve()
        }
      })
    })
  }

  destroy () {
    if (!this.isConnected) {
      return Promise.resolve()
    }

    return this.transaction('destroy', {}, 'success', 5000).then(() => {
      this.cleanup()
    }).catch(() => {
      this.cleanup()
    })
  }

  destroyPlugin (plugin) {
    return new Promise((resolve, reject) => {
      if (!(plugin instanceof JanusPlugin)) {
        reject(new Error('plugin is not a JanusPlugin'))
        return
      }

      if (!this.pluginHandles[plugin.janusHandleId]) {
        reject(new Error('unknown plugin'))
        return
      }

      this.transaction('detach', { plugin: plugin.pluginName, handle_id: plugin.janusHandleId }, 'success', 5000).then(() => {
        delete this.pluginHandles[plugin.janusHandleId]
        plugin.detach()

        resolve()
      }).catch((err) => {
        delete this.pluginHandles[plugin.janusHandleId]
        plugin.detach()

        reject(err)
      })
    })
  }

  onMessage (message) {
    // message = message.payloadString
    // eslint-disable-next-line no-console
    //  console.error(JSON.parse(message))
    let json
    try {
      json = JSON.parse(message)
    } catch (err) {
      this.logger.error('cannot parse message', message.data)
      return
    }

    /*    if (json.janus === 'success' && transaction) {
        notification().emit('connected', json)
      } */

    // this.logger.debug('JANUS GOT', json)
    if (json.janus === 'timeout' && json.session_id !== this.sessionId) {
      this.logger.debug('GOT timeout from another websocket') // seems like a bug in janus timeout handler :)
      return
    }

    if (json.janus === 'keepalive') { // Do nothing
      return
    }

    if (json.janus === 'ack') { // Just an ack, we can probably ignore
      const transaction = this.getTransaction(json)
      if (transaction && transaction.resolve) {
        transaction.resolve(json)
      }
      return
    }

    if (json.janus === 'success') { // Success!
      const transaction = this.getTransaction(json)
      if (!transaction) {
        return
      }

      const pluginData = json.plugindata
      if (pluginData === undefined || pluginData === null) {
        transaction.resolve(json)
        return
      }

      const sender = json.sender
      if (!sender) {
        transaction.resolve(json)
        this.logger.error('Missing sender for plugindata', json)
        return
      }

      const pluginHandle = this.pluginHandles[sender]
      if (!pluginHandle) {
        this.logger.error('This handle is not attached to this session', json)
        return
      }

      transaction.resolve({ data: pluginData.data, json })
      return
    }

    if (json.janus === 'webrtcup') { // The PeerConnection with the gateway is up! Notify this
      const sender = json.sender
      if (!sender) {
        this.logger.warn('Missing sender...')
        return
      }
      const pluginHandle = this.pluginHandles[sender]
      if (!pluginHandle) {
        this.logger.error('This handle is not attached to this session', sender)
        return
      }
      pluginHandle.webrtcState(true)
      return
    }

    if (json.janus === 'hangup') { // A plugin asked the core to hangup a PeerConnection on one of our handles
      const sender = json.sender
      if (!sender) {
        this.logger.warn('Missing sender...')
        return
      }
      const pluginHandle = this.pluginHandles[sender]
      if (!pluginHandle) {
        this.logger.error('This handle is not attached to this session', sender)
        return
      }
      pluginHandle.webrtcState(false, json.reason)
      pluginHandle.hangup()
      return
    }

    if (json.janus === 'detached') { // A plugin asked the core to detach one of our handles
      const sender = json.sender
      if (!sender) {
        this.logger.warn('Missing sender...')
        return
      }
      return
    }

    if (json.janus === 'media') { // Media started/stopped flowing
      const sender = json.sender
      if (!sender) {
        this.logger.warn('Missing sender...')
        return
      }
      const pluginHandle = this.pluginHandles[sender]
      if (!pluginHandle) {
        this.logger.error('This handle is not attached to this session', sender)
        return
      }
      pluginHandle.mediaState(json.type, json.receiving)
      return
    }

    if (json.janus === 'slowlink') { // Trouble uplink or downlink
      this.logger.debug('Got a slowlink event on session ' + this.sessionId)
      this.logger.debug(json)
      const sender = json.sender
      if (!sender) {
        this.logger.warn('Missing sender...')
        return
      }
      const pluginHandle = this.pluginHandles[sender]
      if (!pluginHandle) {
        this.logger.error('This handle is not attached to this session', sender)
        return
      }
      pluginHandle.slowLink(json.uplink, json.nacks)
      return
    }

    if (json.janus === 'error') { // Oops, something wrong happened
      if (json.error && json.error.code && !ignoredErrorCodes.includes(json.error.code)) {
        this.logger.error('Janus error response' + json)
      }

      const transaction = this.getTransaction(json, true)
      if (transaction && transaction.reject) {
        if (transaction.request) {
          this.logger.debug('Janus Error: rejecting transaction', transaction.request, json)
        }
        transaction.reject(json)
      }
      return
    }

    if (json.janus === 'event') {
      const sender = json.sender
      if (!sender) {
        this.logger.warn('Missing sender...')
        return
      }
      const pluginData = json.plugindata
      if (pluginData === undefined || pluginData === null) {
        this.logger.error('Missing plugindata...')
        return
      }

      const pluginHandle = this.pluginHandles[sender]
      if (!pluginHandle) {
        this.logger.error('This handle is not attached to this session', sender)
        return
      }

      const data = pluginData.data
      const transaction = this.getTransaction(json)
      if (transaction) {
        if (data.error_code) {
          transaction.reject({ data, json })
        } else {
          transaction.resolve({ data, json })
        }
        return
      }

      pluginHandle.onmessage(data, json)
      return
    }

    this.logger.warn('Unknown message/event ' + json.janus + ' on session ' + this.sessionId)
    this.logger.debug(json)
  }

  onClose () {
    if (!this.isConnected) {
      return
    }

    this.isConnected = false
    this.logger.error('Lost connection to the gateway (is it down?)')
  }

  keepAlive (isScheduled) {
    if (!this.mqttClient || !this.isConnected || !this.sessionId) {
      return
    }

    if (isScheduled) {
      setTimeout(() => { this.keepAlive() }, this.config.keepAliveInterval)
    } else {
      // logger.debug('Sending Janus keepalive')
      this.transaction('keepalive').then(() => {
        setTimeout(() => { this.keepAlive() }, this.config.keepAliveInterval)
      }).catch((err) => {
        this.logger.warn('Janus keepalive error', err)
      })
    }
  }

  getTransaction (json, ignoreReplyType = false) {
    const type = json.janus
    const transactionId = json.transaction
    if (
      transactionId &&
            Object.prototype.hasOwnProperty.call(this.transactions, transactionId) &&
            (ignoreReplyType || this.transactions[transactionId].replyType === type)
    ) {
      const ret = this.transactions[transactionId]
      delete this.transactions[transactionId]
      return ret
    }
  }

  cleanup () {
    this._cleanupPlugins()
    this._cleanupTransactions()
  }

  _cleanupPlugins () {
    Object.keys(this.pluginHandles).forEach((pluginId) => {
      const plugin = this.pluginHandles[pluginId]
      delete this.pluginHandles[pluginId]
      plugin.detach()
    })
  }

  _cleanupTransactions () {
    Object.keys(this.transactions).forEach((transactionId) => {
      const transaction = this.transactions[transactionId]
      if (transaction.reject) {
        transaction.reject()
      }
    })
    this.transactions = {}
  }
}

module.exports = JanusMqtt
