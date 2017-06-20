var Transation = require('transactionblockchain')
var Block      = require('blockblockchain');
var Util       = require('./src/util');
var Miner      = require('./src/miner');
var Promise    = require('promise');
var keypairs   = require('./test/keypairs');

var owner = keypairs.owner;
var sender = keypairs.sender;

var miner1 = new Miner(1337, '196.24.185.115', sender.public, sender.private, sender.public, Util.createLog('miner1.log'));
var miner2 = new Miner(1338, '196.24.185.115', owner.public, owner.private, owner.public, Util.createLog('miner2.log'));

miner1.start(() => {
    miner2.start(() => {
        miner1.node_list = [{ address: '196.24.185.115', port: 1338 }];
        miner2.node_list = [{ address: '196.24.185.115', port: 1337 }];

        miner1.actively_mining = true;
        miner2.actively_mining = true;
    });
});
