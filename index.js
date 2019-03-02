'use strict';
var CryptoJS = require("crypto-js");
var express = require("express");
var bodyParser = require('body-parser');
var WebSocket = require("ws");
var level = require('level');


var http_port = process.env.HTTP_PORT || 3001;
var p2p_port = process.env.P2P_PORT || 6001;
var initialPeers = process.env.PEERS ? process.env.PEERS.split(',') : [];
var db = level('blockchains-'+ http_port);
var difficulty = 2;

class Block {
    constructor(index, previousHash, timestamp, data, hash) {
        this.index = index;
        this.previousHash = previousHash.toString();
        this.timestamp = timestamp;
        this.data = data;
        this.hash = hash.toString();
        this.nonce = 0;
        this.difficulty = difficulty;
        if (index === 0) {
            this.difficulty = 0;
        }

    }
}

var sockets = [];
var MessageType = {
    QUERY_LATEST: 0,
    QUERY_ALL: 1,
    RESPONSE_BLOCKCHAIN: 2
};

var getGenesisBlock = () => {
    return new Block(0, "0", 1549871973, "一个创世区块", "816534932c2b7154836da6afc367695e6337db8a921823784c14378abed4f7d7");;
};

var blockchain = [];

var initBlockChain = () => {

    db.get('0', function (err, value) {
        if (err) {
            //first time to start,init genisis block
            var b = getGenesisBlock();
            db.put('0',JSON.stringify(b),function (err){
                if (err) return console.log('Ooops!', err);
                blockchain.push(b);
                console.log(JSON.stringify(blockchain));
            });
            return
        }
        // read the blockchain from db
        db.createReadStream()
            .on('data', function (data) {
                blockchain.push(JSON.parse(data.value));
            })
            .on('error', function (err) {
                console.log('Oh my!', err)
            })
            .on('close', function () {
                console.log('Stream closed')
            })
            .on('end', function () {
                console.log(JSON.stringify(blockchain));
            });

    })

};

var initHttpServer = () => {
    var app = express();
    app.use(bodyParser.json());
    app.all('*', function(req, res, next) {
        res.header("Access-Control-Allow-Origin", "*");
        res.header("Access-Control-Allow-Headers", "X-Requested-With,authorization");
        res.header("Access-Control-Allow-Methods","PUT,POST,GET,DELETE,OPTIONS");
        res.header("X-Powered-By",' 3.2.1');
        res.header("Content-Type", "application/json;charset=utf-8");
        next();
    });

    app.get('/blocks', (req, res) => res.send(JSON.stringify(blockchain)));
    app.post('/mineBlock', (req, res) => {
        var newBlock = generateNextBlock(req.body.data);
        addBlock(newBlock);
        broadcast(responseLatestMsg());
        console.log('添加区块: ' + JSON.stringify(newBlock));
        res.send();
    });
    app.get('/peers', (req, res) => {
        res.send(sockets.map(s => s._socket.remoteAddress + ':' + s._socket.remotePort));
    });
    app.get('/getLatestHash', (req, res) => {
        res.send(blockchain[blockchain.length-1]);
    });
    app.post('/addPeer', (req, res) => {
        connectToPeers([req.body.peer]);
        res.send();
    });
    app.listen(http_port, () => console.log('监听 http 端口: ' + http_port));
};


var initP2PServer = () => {
    var server = new WebSocket.Server({port: p2p_port});
    server.on('connection', ws => initConnection(ws));
    console.log('监听 websocket p2p 端口: ' + p2p_port);

};

var initConnection = (ws) => {
    sockets.push(ws);
    initMessageHandler(ws);
    initErrorHandler(ws);
    write(ws, queryChainLengthMsg());
};

var initMessageHandler = (ws) => {
    ws.on('message', (data) => {
        var message = JSON.parse(data);
        console.log('收到信息' + JSON.stringify(message));
        switch (message.type) {
            case MessageType.QUERY_LATEST:
                write(ws, responseLatestMsg());
                break;
            case MessageType.QUERY_ALL:
                write(ws, responseChainMsg());
                break;
            case MessageType.RESPONSE_BLOCKCHAIN:
                handleBlockchainResponse(message);
                break;
        }
    });
};

var initErrorHandler = (ws) => {
    var closeConnection = (ws) => {
        console.log('连接节点失败: ' + ws.url);
        sockets.splice(sockets.indexOf(ws), 1);
    };
    ws.on('close', () => closeConnection(ws));
    ws.on('error', () => closeConnection(ws));
};


var generateNextBlock = (blockData) => {
    var previousBlock = getLatestBlock();
    var nextIndex = previousBlock.index + 1;
    var nextTimestamp = new Date().getTime() / 1000;
    var nextHash = calculateHash(nextIndex, previousBlock.hash, nextTimestamp, blockData, 0, difficulty);

    var nextBlock = new Block(nextIndex, previousBlock.hash, nextTimestamp, blockData, nextHash);
    while (nextBlock.hash.substring(0, difficulty) !== Array(difficulty + 1).join("0")) {
        nextBlock.nonce++;
        nextBlock.hash = calculateHash(nextIndex, previousBlock.hash, nextTimestamp, blockData, nextBlock.nonce, difficulty);
    }
    console.log('找到符合的hash值：', nextBlock.hash);
    return nextBlock;
};


var calculateHashForBlock = (block) => {
    return calculateHash(block.index, block.previousHash, block.timestamp, block.data, block.nonce, block.difficulty);
};

var calculateHash = (index, previousHash, timestamp, data, nonce, difficulty) => {
    return CryptoJS.SHA256(index + previousHash + timestamp + data + nonce + difficulty).toString();
};

var addBlock = (newBlock) => {
    if (isValidNewBlock(newBlock, getLatestBlock())) {
        db.put(newBlock.index,JSON.stringify(newBlock),function(err){
            if (err) {return console.log('Ooops!', err);}

        });
        blockchain.push(newBlock);
    }
};

var isValidNewBlock = (newBlock, previousBlock) => {
    if (previousBlock.index + 1 !== newBlock.index) {
        console.log('index无效');
        return false;
    } else if (previousBlock.hash !== newBlock.previousHash) {
        console.log('previoushash无效');
        return false;
    } else if (calculateHashForBlock(newBlock) !== newBlock.hash) {
        console.log(typeof (newBlock.hash) + ' ' + typeof calculateHashForBlock(newBlock));
        console.log('无效hash: ' + calculateHashForBlock(newBlock) + ' ' + newBlock.hash);
        return false;
    } else if (newBlock.hash.substring(0, newBlock.difficulty) !== Array(newBlock.difficulty + 1).join("0")) {
        console.log('hash与difficulty不对应');
        return false;
    }
    //遍历一遍看前面有没有改过
    return true;
};

var connectToPeers = (newPeers) => {
    newPeers.forEach((peer) => {
        var ws = new WebSocket(peer);
        ws.on('open', () => initConnection(ws));
        ws.on('error', () => {
            console.log('connection failed')
        });
    });
};

var handleBlockchainResponse = (message) => {
    var receivedBlocks = JSON.parse(message.data).sort((b1, b2) => (b1.index - b2.index));
    var latestBlockReceived = receivedBlocks[receivedBlocks.length - 1];
    var latestBlockHeld = getLatestBlock();
    if (latestBlockReceived.index > latestBlockHeld.index) {
        console.log('区块链可能发生改变. 我的: ' + latestBlockHeld.index + ' 节点的: ' + latestBlockReceived.index);
        if (latestBlockHeld.hash === latestBlockReceived.previousHash) {
            console.log("我们可以把区块添加到链上");

            db.put(latestBlockReceived.index,JSON.stringify(latestBlockReceived),function(err){
                if (err) {return console.log('Ooops!', err);}

            });
            blockchain.push(latestBlockReceived);
            broadcast(responseLatestMsg());
        } else if (receivedBlocks.length === 1) {
            console.log("我需要整条区块链");
            broadcast(queryAllMsg());
        } else {
            console.log("收到的区块链比我的更长");
            replaceChain(receivedBlocks);
        }
    } else {
        console.log('收到区块链比我的更短，不需要更新');
    }
};

var replaceChain = (newBlocks) => {
    if (isValidChain(newBlocks) && newBlocks.length > blockchain.length) {
        console.log('收到的区块链经检合法，替换');
        for (var i = 0; i<=blockchain.length-1; i++){
            db.del(i, function(err){
                if (err) return console.log(err);
            });
        }
        blockchain = newBlocks;
        for (var i = 0; i<=blockchain.length-1; i++){
            db.put(i, JSON.stringify(blockchain[i]), function(err){
                if (err) return console.log(err);
            })
        }
        broadcast(responseLatestMsg());
    } else {
        console.log('收到的区块链不合法');
    }
};

var isValidChain = (blockchainToValidate) => {
    if (JSON.stringify(blockchainToValidate[0]) !== JSON.stringify(getGenesisBlock())) {
        return false;
    }
    var tempBlocks = [blockchainToValidate[0]];
    for (var i = 1; i < blockchainToValidate.length; i++) {
        if (isValidNewBlock(blockchainToValidate[i], tempBlocks[i - 1])) {
            tempBlocks.push(blockchainToValidate[i]);
        } else {
            return false;
        }
    }
    return true;
};

var getLatestBlock = () => blockchain[blockchain.length - 1];
var queryChainLengthMsg = () => ({'type': MessageType.QUERY_LATEST});
var queryAllMsg = () => ({'type': MessageType.QUERY_ALL});
var responseChainMsg = () =>({
    'type': MessageType.RESPONSE_BLOCKCHAIN, 'data': JSON.stringify(blockchain)
});
var responseLatestMsg = () => ({
    'type': MessageType.RESPONSE_BLOCKCHAIN,
    'data': JSON.stringify([getLatestBlock()])
});

var write = (ws, message) => ws.send(JSON.stringify(message));
var broadcast = (message) => sockets.forEach(socket => write(socket, message));

connectToPeers(initialPeers);
initBlockChain();
initHttpServer();
initP2PServer();
