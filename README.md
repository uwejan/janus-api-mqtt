# Javascript (node and browser side) API for Janus WebRTC Gateway, Using MQTT


To test it on localhost, visit: chrome://flags/#allow-insecure-localhost
___
Thanks to the awesome original implementation using web-sockets  [TechTeamer/janus-api](https://github.com/TechTeamer/janus-api)
___
Quick and might be buggy implementation on using `mqtt` transport.
#HowTos
```
const common = {
    janus: {
        url: 'mqtt.broker.com', // has to be using SSL
        port: 9000,
        userName: 'userName',
        password: 'password',
        clientId: 'clientId12345',
        subTopic: 'from-janus',
        pubTopic: 'to-janus',
        filterDirectCandidates: true,
        recordDirectory: '/workspace/records/',
        bitrate: 774144,
        firSeconds: 10,
        publishers: 20
        .....
    }
}
```
```
const janusConfig = new JanusConfig(common.janus)
```
