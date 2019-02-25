var level = require('level');

var http_port = process.env.HTTP_PORT || 3003;
var db = level('blockchains-'+ http_port);

db.createReadStream()
    .on('data', function (data) {
        console.log(data.key, '=', data.value)
    })
    .on('error', function (err) {
        console.log('Oh my!', err)
    })
    .on('close', function () {
        console.log('Stream closed')
    })
    .on('end', function () {
        console.log('Stream ended')
    })