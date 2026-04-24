const bip39 = require("bip39");

// Full standard list of possible 12-word mnemonic words (2048 words).
const wordList = bip39.wordlists.english;

module.exports = wordList;
