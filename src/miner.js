const Transaction = require('transactionblockchain');
const Message = require('./message');
const Promise = require('promise');
const Block = require('blockblockchain');
const Util = require('./util');
const net = require('net');

function Miner(port, host, miner_public_key, miner_private_key, owner_public_key, logger) {
    this.transaction_pool = [];
    this.transaction_map = {};
    this.blockchain = [];
    this.node_list = [];
    this.port = port;
    this.host = host;
    this.logger = logger || console;
    this.actively_mining = false;

    this.miner_public_key = miner_public_key;
    this.miner_private_key = miner_private_key;
    this.owner_public_key = owner_public_key;

    this.flushTransactionPool = flushTransactionPool.bind(this);
    this.addTransactionToPool = addTransactionToPool.bind(this);
    this.flushTransaction = flushTransaction.bind(this);
    this.receiveNewBlockchain = receiveNewBlockchain.bind(this);
    this.createGenesisBlock = createGenesisBlock.bind(this);
    this.createGenesisIfNeeded = createGenesisIfNeeded.bind(this);
    this.createNewCoin = createNewCoin.bind(this);
    this.latestBlock = latestBlock.bind(this);
    this.pushNewBlock = pushNewBlock.bind(this);
    this.computeHash = computeHash.bind(this);
    this.logChain = logChain.bind(this);
    this.addNodes = addNodes.bind(this);
    this.start = start.bind(this);
    this.main = main.bind(this);

    // TODO use stream-json and move to a streaming model for message handling
    this.server = net.createServer((socket) => {
        var message = '';

        // socket.on('data', Message.handler(this, socket));
        socket.on('data', (chunk) => message += chunk.toString('utf8'));
        socket.on('close', () => Message.handler(JSON.parse(message), this, socket));
    });
}

// Start up the miner's main loop and TCP server.
function start(callback) {
    this.server.listen(this.port, this.host, callback);
    this.server.on('error', (error) => console.error(error));

    this.main();
}

// Add new nodes to the node list.
function addNodes(nodes) {
    nodes.forEach((node) => {
        var already_in_list = false;

        this.node_list.forEach((our_node) => {
            if (node.address == our_node.address && node.port == our_node.port)
                already_in_list = true;
        });

        if (!already_in_list)
            this.node_list.push(node);
    });
}

// Add all valid transactions to blockchain, clear the transaction pool.
function flushTransactionPool() {
    var transaction_promises = this.transaction_pool.map(this.flushTransaction);

    this.transaction_pool = [];
    return Util.waitForAll(transaction_promises);
}

// Flush the entire transaction pool into the current block.
function flushTransaction(transaction) {
    return Util
        .unblock()
        .then(() => {
            this.latestBlock().data.push(transaction);
            let valid = Transaction.verify(transaction, this.transaction_map, this.latestBlock());
            this.latestBlock().data.pop();

            if (valid) {
                // TODO this should be moved to Block.addTransaction.
                Transaction.addToMap(transaction, this.transaction_map);

                Block.addTransaction(this.latestBlock(), transaction);
            }
        });
}

// Create the genesis block and reset state.
function createGenesisBlock() {
    this.blockchain = [ Block.create("GENESIS") ];
    this.transaction_map = {};
}

// We only need to create a genesis block if there is nothing in the blockchain.
function createGenesisIfNeeded() {
    return new Promise((resolve, reject) => {
        if (this.blockchain.length == 0)
            this.createGenesisBlock();

        return resolve();
    });
}

// Create a new coin transaction for new blocks.
function createNewCoin() {
    return Transaction.create(
        this.miner_public_key,
        this.miner_private_key,
        [],
        [{ owner_public_key: this.miner_public_key, value: 1.0 }],
        Transaction.TYPES.NEW_COIN
    );
}

// Get latest block in the blockchain, assuming it's of non-zero length.
function latestBlock() {
    return this.blockchain[ this.blockchain.length - 1 ];
}

// Add a transaction into the transaction pool.
function addTransactionToPool(transaction) {
    this.transaction_pool.push(transaction);
}

// Add a new block onto the end of the current chain and push a new coin into it.
function pushNewBlock() {
    this.logger.log("Pushing new block onto blockchain:");

    this.blockchain.push( Block.createFrom(this.latestBlock()) );
    this.addTransactionToPool( this.createNewCoin() );
    this.logChain(this.blockchain, '    ');
}

// Receive and consider a new blockchain as part of a broadcast.
function receiveNewBlockchain(blockchain) {
    this.logger.log("Received new blockchain.");

    if (blockchain.length > this.blockchain.length) {
        this.logger.log("Blockchain was longer than our current, verifying.");
        var verificationMetadata = Block.getVerificationMetadata(blockchain);
        this.logger.log("Verification complete.");

        if (verificationMetadata.valid) {
            this.logger.log("Blockchain was valid, replacing current with:");
            this.latestBlock().data.map((transaction) => this.addTransactionToPool(transaction));

            this.blockchain = blockchain;
            this.transaction_map = verificationMetadata.transaction_map;

            this.logChain(this.blockchain, '    ');
            this.pushNewBlock();
        } else {
            this.logger.log("Blockchain was invalid - ignoring.");
            this.logger.log("Invalid blockchain:");
            this.logChain(blockchain, '    ');
        }
    } else {
        this.logger.log("Blockchain not longer than current - ignoring.");
    }
}

// Log the given blockchain to the console.
function logChain(blockchain, prefix) {
    var prefix = prefix || '';

    blockchain.forEach((block) => {
        this.logger.log(prefix + Block.toString(block));
    });
    console.log(blockchain);
    this.logger.log("Is chain valid: " + Block.getVerificationMetadata(this.blockchain).valid);
}

// Run hash computation as part of the traditional bitcoin mining operation.
function computeHash() {
    // If we aren't mining we delay to keep CPU usage down.
    if (!this.actively_mining)
        return Util.delay(100);

    return new Promise((resolve, reject) => {
        this.latestBlock().nonce++;

        if (Block.computeHash(this.latestBlock()).startsWith("000")) {
            this.logger.log('Solved the hash problem.');

            var completed_exports = 0;
            this.node_list.map((node) => {
                var client = net.createConnection(node.port, node.address, () => {
                    this.logger.log("Sending blockchain to: " + node.address + '::' + node.port + '.');

                    Message.exportBlocks(this, client, () => {
                        client.end();

                        // If we're finished exporting, resolve the promise.
                        if (++completed_exports == this.node_list.length) {
                            this.pushNewBlock();
                            return resolve();
                        }
                    });
                })
            });
        } else {
            return resolve()
        }
    });
}

// Main miner loop - constantly running.
function main() {
    return Util
        .unblock()
        .then(this.createGenesisIfNeeded)
        .then(this.flushTransactionPool)
        .then(this.computeHash)
        .then(this.main)
        .catch((error) => console.error(error))
}

module.exports = Miner;
