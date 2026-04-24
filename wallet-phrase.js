const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const wordList = require("./word-list");

const HISTORY_FILE = path.join(__dirname, ".wallet-phrase-history.json");
const MAX_HISTORY = 5000;
const configuredWordCount = Number.parseInt(process.env.SEED_PHRASE_WORD_COUNT || "24", 10);
const TARGET_PHRASE_WORD_COUNT = [12, 15, 18, 21, 24].includes(configuredWordCount)
	? configuredWordCount
	: 24;

function hashPhrase(phrase) {
	return crypto.createHash("sha256").update(phrase).digest("hex");
}

function loadHistory() {
	try {
		if (!fs.existsSync(HISTORY_FILE)) {
			return [];
		}

		const data = fs.readFileSync(HISTORY_FILE, "utf8");
		const parsed = JSON.parse(data);
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		return [];
	}
}

function saveHistory(history) {
	const trimmed = history.slice(-MAX_HISTORY);
	fs.writeFileSync(HISTORY_FILE, JSON.stringify(trimmed, null, 2), "utf8");
}

function pickUniqueWords(words, count = 12) {
	const pickedIndexes = new Set();
	while (pickedIndexes.size < count) {
		pickedIndexes.add(crypto.randomInt(0, words.length));
	}

	return Array.from(pickedIndexes, (index) => words[index]);
}

function generateWalletPhrase(words, count = TARGET_PHRASE_WORD_COUNT) {
	if (!Array.isArray(words) || words.length < count) {
		throw new Error(`word-list must contain at least ${count} words`);
	}

	const history = loadHistory();
	const seen = new Set(history);

	for (let attempt = 0; attempt < 20; attempt += 1) {
		const phrase = pickUniqueWords(words, count).join(" ");
		const phraseHash = hashPhrase(phrase);

		if (!seen.has(phraseHash)) {
			history.push(phraseHash);
			saveHistory(history);
			return phrase;
		}
	}

	const fallbackPhrase = pickUniqueWords(words, count).join(" ");
	history.push(hashPhrase(fallbackPhrase));
	saveHistory(history);
	return fallbackPhrase;
}

function generateWalletSecretPhrase(wordCount = TARGET_PHRASE_WORD_COUNT) {
	const safeWordCount = [12, 15, 18, 21, 24].includes(Number(wordCount))
		? Number(wordCount)
		: TARGET_PHRASE_WORD_COUNT;
	return generateWalletPhrase(wordList, safeWordCount);
}

const WALLET_SECRET_PHRASE = generateWalletSecretPhrase();

module.exports = {
	generateWalletSecretPhrase,
	WALLET_SECRET_PHRASE,
};