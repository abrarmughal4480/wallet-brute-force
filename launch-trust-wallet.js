const { spawn, spawnSync } = require("child_process");
const path = require("path");
const { chromium } = require("playwright");
const {
	WALLET_SECRET_PHRASE,
	generateWalletSecretPhrase,
} = require("./wallet-phrase");
require("dotenv").config({ path: path.join(__dirname, ".env.local") });

function requireEnv(name) {
	const value = process.env[name];
	if (!value) {
		throw new Error(`Missing required env var: ${name}`);
	}
	return value;
}

const EXTENSION_ID = requireEnv("EXTENSION_ID");
const DEFAULT_PATH = requireEnv("DEFAULT_PATH");
const CDP_ENDPOINT = requireEnv("CDP_ENDPOINT");
const CHROME_EXECUTABLE =
	process.env.CHROME_EXECUTABLE || process.env.EDGE_EXECUTABLE || "chrome";
const CHROME_PROFILE_DIRECTORY =
	process.env.CHROME_PROFILE_DIRECTORY ||
	process.env.EDGE_PROFILE_DIRECTORY ||
	"Default";
const CHROME_REMOTE_DEBUGGING_PORT =
	process.env.CHROME_REMOTE_DEBUGGING_PORT ||
	process.env.EDGE_REMOTE_DEBUGGING_PORT ||
	"9222";
const SECRET_PHRASE_MAX_ATTEMPTS = Math.max(
	1,
	Number.parseInt(process.env.SECRET_PHRASE_MAX_ATTEMPTS || "25", 10) || 25
);
const OPEN_WALLET_TIMEOUT_MS = Math.max(
	1000,
	Number.parseInt(process.env.OPEN_WALLET_TIMEOUT_MS || "5000", 10) || 5000
);
const RETRY_DELAY_MS = 5000;

const onboardingUrl = `chrome-extension://${EXTENSION_ID}/home.html#/onboarding/`;

function normalizeExtensionUrl(rawUrl) {
	if (!rawUrl || !rawUrl.trim()) {
		return onboardingUrl;
	}

	const trimmed = rawUrl.trim();
	if (trimmed.startsWith("extension://")) {
		return `chrome-${trimmed}`;
	}

	if (trimmed.startsWith("chrome-extension://")) {
		return trimmed;
	}

	return trimmed;
}

const defaultUrl = normalizeExtensionUrl(
	`chrome-extension://${EXTENSION_ID}/${DEFAULT_PATH}`
);
const urlFromArg = process.argv[2];
const targetUrl = normalizeExtensionUrl(urlFromArg || onboardingUrl || defaultUrl);
const configuredSecretPhrase = process.env.WALLET_SECRET_PHRASE || "";

function getSecretPhraseForAttempt(attempt) {
	if (attempt === 1 && configuredSecretPhrase.trim()) {
		return configuredSecretPhrase.trim();
	}

	if (attempt === 1) {
		return WALLET_SECRET_PHRASE;
	}

	return generateWalletSecretPhrase();
}

if (process.platform !== "win32") {
	console.error("This script currently supports Windows only.");
	process.exit(1);
}

function delay(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
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
		await delay(300);
	}

	console.log("CDP not reachable, restarting Chrome once...");
	spawnSync("cmd.exe", ["/c", "taskkill", "/IM", "chrome.exe", "/F"], {
		stdio: "ignore",
		windowsHide: true,
	});

	await delay(500);
	launchChromeForCdp(url);

	for (let attempt = 0; attempt < 30; attempt += 1) {
		if (await isCdpReady()) {
			return;
		}
		await delay(300);
	}

	throw new Error(
		"Chrome CDP not available on port 9222 even after restart."
	);
}

async function getOrCreateTargetPage(browser, url) {
	const primaryContext = browser.contexts()[0] || (await browser.newContext());
	const targetPage = await primaryContext.newPage();

	await targetPage.goto(url, { waitUntil: "domcontentloaded" });
	await targetPage.bringToFront();
	await delay(300);

	// Fresh tab policy: close every other tab (including previously opened onboarding tabs).
	for (const context of browser.contexts()) {
		for (const page of context.pages()) {
			if (page === targetPage || page.isClosed()) {
				continue;
			}

			try {
				await page.close({ runBeforeUnload: true });
			} catch {
				// Ignore close races for tabs that disappear while iterating.
			}
		}
	}

	await targetPage.bringToFront();
	console.log(`Fresh onboarding tab ready: ${url}`);
	return targetPage;
}

function isTargetLabel(text) {
	const normalized = (text || "").toLowerCase().replace(/\s+/g, " ").trim();
	return (
		normalized.includes("already have") ||
		normalized.includes("have an account") ||
		normalized.includes("i already have a wallet")
	);
}

async function clickInFrame(frame) {
	const locators = [
		frame.getByRole("button", { name: /I already have a wallet/i }),
		frame.locator("button", { hasText: /already have|have an account/i }),
	];

	for (const locator of locators) {
		if ((await locator.count()) > 0) {
			const button = locator.first();
			await button.waitFor({ state: "visible", timeout: 5000 });
			if (!(await button.isEnabled())) {
				continue;
			}

			try {
				await button.click({ timeout: 5000 });
				return true;
			} catch {
				continue;
			}
		}
	}

	const clickedByEval = await frame.evaluate(() => {
		const buttons = Array.from(document.querySelectorAll("button"));
		for (const button of buttons) {
			const text = (button.textContent || "")
				.toLowerCase()
				.replace(/\s+/g, " ")
				.trim();
			if (
				text.includes("already have") ||
				text.includes("have an account") ||
				text.includes("i already have a wallet")
			) {
				button.click();
				return true;
			}
		}
		return false;
	});

	return clickedByEval;
}

async function clickHelperEntry(page) {
	const helperButtons = [
		page.getByRole("button", { name: /open my wallet/i }),
		page.getByRole("button", { name: /open side panel/i }),
		page.locator("button", { hasText: /open my wallet|open side panel/i }),
	];

	for (const helper of helperButtons) {
		if ((await helper.count()) > 0) {
			await helper.first().click({ timeout: 3000 });
			return true;
		}
	}

	return false;
}

async function clickAlreadyHaveWallet(page) {
	const funcStart = Date.now();
	await page.bringToFront();
	await page.waitForLoadState("domcontentloaded");

	const alreadyOnSelection = await page.evaluate(() => {
		const title = document.querySelector('[data-testid="onboarding-step-title"]');
		const heading = document.querySelector("h3");
		const text = `${title?.textContent || ""} ${heading?.textContent || ""}`
			.toLowerCase()
			.replace(/\s+/g, " ")
			.trim();
		return text.includes("select your existing wallet");
	});

	if (alreadyOnSelection) {
		const funcTime = Date.now() - funcStart;
		console.log(`Already on existing wallet selection screen (${funcTime}ms)`);
		return;
	}

	for (let attempt = 0; attempt < 8; attempt += 1) {
		const candidatePages = page.context().pages();

		for (const candidate of candidatePages) {
			for (const frame of candidate.frames()) {
				const clicked = await clickInFrame(frame);
				if (clicked) {
					const funcTime = Date.now() - funcStart;
					console.log(`"I already have a wallet" button clicked in ${funcTime}ms`);
					return;
				}
			}
		}

		if (attempt === 0) {
			const visibleButtons = await page
				.locator("button")
				.evaluateAll((buttons) =>
					buttons
						.map((button) => (button.textContent || "").replace(/\s+/g, " ").trim())
						.filter(Boolean)
				);
			const matched = visibleButtons.filter((text) => isTargetLabel(text));
			console.log(
				`Visible buttons: ${visibleButtons.slice(0, 6).join(" | ") || "none"}`
			);
			if (matched.length > 0) {
				console.log(`Matched labels: ${matched.join(" | ")}`);
			}
		}

		for (const candidate of candidatePages) {
			const helperClicked = await clickHelperEntry(candidate);
			if (helperClicked) {
				console.log("Clicked helper button, retrying onboarding...");
			}
		}

		if (attempt === 2 || attempt === 5) {
			await page.goto(targetUrl, { waitUntil: "domcontentloaded" });
			await page.bringToFront();
		}

		await delay(500);
	}

	const funcTime = Date.now() - funcStart;
	throw new Error(`Could not find onboarding button: I already have a wallet (after ${funcTime}ms)`);
}

async function clickOtherMobileWalletOrExtension(page) {
	const funcStart = Date.now();
	const timeoutMs = 30000;
	const start = Date.now();

	while (Date.now() - start < timeoutMs) {
		const candidatePages = page.context().pages();

		for (const candidate of candidatePages) {
			await candidate.waitForLoadState("domcontentloaded");

			const byTestId = candidate.locator(
				'button[data-testid="onboarding-select-import-method-undefined"]'
			);
			if ((await byTestId.count()) > 0) {
				await byTestId.first().click({ timeout: 5000 });
				const funcTime = Date.now() - funcStart;
				console.log(`"Other mobile wallet or extension" button clicked in ${funcTime}ms`);
				return;
			}

			const byText = candidate.getByRole("button", {
				name: /Other mobile wallet or extension/i,
			});
			if ((await byText.count()) > 0) {
				await byText.first().click({ timeout: 5000 });
				const funcTime = Date.now() - funcStart;
				console.log(`"Other mobile wallet or extension" button clicked in ${funcTime}ms`);
				return;
			}

			for (const frame of candidate.frames()) {
				const clickedInFrame = await frame.evaluate(() => {
					const buttons = Array.from(document.querySelectorAll("button"));
					for (const button of buttons) {
						const text = (button.textContent || "")
							.toLowerCase()
							.replace(/\s+/g, " ")
							.trim();
						if (text.includes("other mobile wallet or extension")) {
							button.click();
							return true;
						}
					}
					return false;
				});

				if (clickedInFrame) {
					const funcTime = Date.now() - funcStart;
					console.log(`"Other mobile wallet or extension" button clicked in ${funcTime}ms`);
					return;
				}
			}
		}

		await delay(400);
	}

	const funcTime = Date.now() - funcStart;
	throw new Error(
		`Could not find option: Other mobile wallet or extension (after ${funcTime}ms)`
	);
}

async function fillSecretPhraseOnly(
	page,
	phrase,
	{ throwIfMissing = true } = {}
) {
	const timeoutMs = 1500;
	const start = Date.now();

	while (Date.now() - start < timeoutMs) {
		const candidatePages = page.context().pages();

		for (const candidate of candidatePages) {
			if (candidate.isClosed()) {
				continue;
			}

			try {
				await candidate.waitForLoadState("domcontentloaded");

				for (const frame of candidate.frames()) {
					try {
						const textarea = frame.locator("textarea:visible").first();
						if ((await textarea.count()) > 0) {
							await textarea.fill(phrase, { timeout: 5000 });
							const value = await textarea.inputValue();
							if (value.trim().split(/\s+/).length >= 12) {
								return true;
							}
						}
					} catch {
						continue;
					}
				}
			} catch {
				continue;
			}
		}

		await delay(300);
	}

	if (throwIfMissing) {
		throw new Error(
			"Could not find Secret Phrase or Private Key textarea to fill"
		);
	}

	return false;
}

async function inspectImportState(page) {
	const timeoutMs = 1000;
	const start = Date.now();

	while (Date.now() - start < timeoutMs) {
		const candidatePages = page.context().pages();

		for (const candidate of candidatePages) {
			if (candidate.isClosed()) {
				continue;
			}

			try {
				await candidate.waitForLoadState("domcontentloaded");

				for (const frame of candidate.frames()) {
					const result = await frame.evaluate(() => {
						const normalize = (value) =>
							(value || "").replace(/\s+/g, " ").trim();

						const buttons = Array.from(document.querySelectorAll("button"));
						const importButton = buttons.find(
							(button) => normalize(button.textContent).toLowerCase() === "import"
						);

						const importEnabled = importButton
							? !(importButton.disabled || importButton.getAttribute("aria-disabled") === "true")
							: null;

						const errorNodes = Array.from(
							document.querySelectorAll(
								'[data-testid="input-error"], .text-error-1-default, [role="alert"], small'
							)
						);

						const errorTexts = errorNodes
							.map((node) => normalize(node.textContent))
							.filter(Boolean);

						const invalidError =
							errorTexts.find((text) =>
								/invalid|incorrect|wrong|not valid|not recognized|failed/i.test(text)
							) || null;

						if (importButton || invalidError) {
							return {
								found: true,
								importEnabled,
								invalidError,
							};
						}

						return { found: false };
					});

					if (result.found) {
						return result;
					}
				}
			} catch {
				continue;
			}
		}

		await delay(50);
	}

	return {
		found: false,
		importEnabled: null,
		invalidError: null,
	};
}

function logImportState(state) {
	if (!state.found) return;
	if (state.invalidError) console.log(`  ⚠ ${state.invalidError}`);
	else if (state.importEnabled === true) console.log(`  ✓ Import enabled`);
	else console.log(`  - Import waiting...`);
}

async function clickImportIfEnabled(page) {
	const timeoutMs = 4000;
	const start = Date.now();

	while (Date.now() - start < timeoutMs) {
		const candidatePages = page.context().pages();

		for (const candidate of candidatePages) {
			if (candidate.isClosed()) {
				continue;
			}

			try {
				await candidate.waitForLoadState("domcontentloaded");

				for (const frame of candidate.frames()) {
					const importButton = frame.getByRole("button", { name: /^import$/i });
					if ((await importButton.count()) === 0) {
						continue;
					}

					const button = importButton.first();
					if (await button.isEnabled()) {
						await button.click({ timeout: 4000 });
						return true;
					}
				}
			} catch {
				continue;
			}
		}

		await delay(300);
	}

	return false;
}

async function clickOpenMyWalletIfVisible(page) {
	const start = Date.now();

	while (Date.now() - start < OPEN_WALLET_TIMEOUT_MS) {
		const candidatePages = page.context().pages();

		for (const candidate of candidatePages) {
			if (candidate.isClosed()) {
				continue;
			}

			try {
				await candidate.waitForLoadState("domcontentloaded");

				for (const frame of candidate.frames()) {
					const byRole = frame.getByRole("button", {
						name: /open my wallet/i,
					});

					if ((await byRole.count()) > 0) {
						const button = byRole.first();
						if (await button.isVisible()) {
							await button.click({ timeout: 5000 });
							console.log("Clicked: Open my wallet");
							return true;
						}
					}

					const clickedByEval = await frame.evaluate(() => {
						const normalize = (value) =>
							(value || "").replace(/\s+/g, " ").trim().toLowerCase();

						const buttons = Array.from(document.querySelectorAll("button"));
						const openWalletButton = buttons.find(
							(button) => normalize(button.textContent) === "open my wallet"
						);

						if (openWalletButton) {
							openWalletButton.click();
							return true;
						}

						return false;
					});

					if (clickedByEval) {
						console.log("Clicked: Open my wallet");
						return true;
					}
				}
			} catch {
				continue;
			}
		}

		await delay(400);
	}

	return false;
}

async function fillAndImportWithRetries(
	page,
	{
		startAttempt = 1,
		firstPhrase,
		firstAttemptAlreadyFilled = false,
		throwIfMissing = true,
	} = {}
) {
	let shouldThrowIfMissing = throwIfMissing;

	for (
		let attempt = startAttempt;
		attempt <= SECRET_PHRASE_MAX_ATTEMPTS;
		attempt += 1
	) {
		const attemptStart = Date.now();
		const phrase =
			attempt === startAttempt && firstPhrase
				? firstPhrase
				: getSecretPhraseForAttempt(attempt);

		if (!(firstAttemptAlreadyFilled && attempt === startAttempt)) {
			const filled = await fillSecretPhraseOnly(page, phrase, {
				throwIfMissing: shouldThrowIfMissing,
			});
			if (!filled) {
				return false;
			}

				console.log(
					`  [Attempt ${attempt}] Filled phrase (${Date.now() - attemptStart}ms)`
				);
		} else {
			console.log(
				`  [Attempt ${attempt}] Using first phrase`
			);
		}

		shouldThrowIfMissing = true;
		await delay(400);

		const importState = await inspectImportState(page);
		logImportState(importState);

		if (importState.importEnabled === true) {
			const clickImportStart = Date.now();
			const clicked = await clickImportIfEnabled(page);
			const importClickTime = Date.now() - clickImportStart;
			if (clicked) {
				const elapsed = Date.now() - attemptStart;
				console.log(`  ✓ Import clicked (${importClickTime}ms, attempt took ${elapsed}ms)`);
				const opened = await clickOpenMyWalletIfVisible(page);
				if (!opened) {
					console.log("  - Wallet open button not found (timeout)");
				}
				return true;
			}
		}

		if (attempt < SECRET_PHRASE_MAX_ATTEMPTS) {
			console.log(`  ✗ Attempt ${attempt} failed, retrying...`);
		}
	}

	throw new Error(
		`Could not find a valid secret phrase after ${SECRET_PHRASE_MAX_ATTEMPTS} attempts`
	);
}

async function main() {
	console.log("Connecting to Chrome and opening Trust Wallet onboarding...");
	const overallStart = Date.now();
	await ensureCdp(targetUrl);

	const browser = await chromium.connectOverCDP(CDP_ENDPOINT);

	try {
		const page = await getOrCreateTargetPage(browser, targetUrl);
		console.log("Waiting for onboarding UI to fully render...");
		const uiStartTime = Date.now();
		await delay(300);
		const uiLoadTime = Date.now() - uiStartTime;
		console.log(`UI ready in ${uiLoadTime}ms`);
		const firstPhrase = getSecretPhraseForAttempt(1);

		const preFilled = await fillSecretPhraseOnly(page, firstPhrase, {
			throwIfMissing: false,
		});
		const clickStart = Date.now();
		if (preFilled) {
			await fillAndImportWithRetries(page, {
				startAttempt: 1,
				firstPhrase,
				firstAttemptAlreadyFilled: true,
				throwIfMissing: false,
			});
			const clickTime = Date.now() - clickStart;
			console.log(`Buttons clicked and imported in ${clickTime}ms`);
			return;
		}

		await clickAlreadyHaveWallet(page);
		console.log("Clicked: I already have a wallet");
		const afterFirstClick = Date.now() - clickStart;
		console.log(`Time to first button click: ${afterFirstClick}ms`);

		await clickOtherMobileWalletOrExtension(page);
		console.log("Clicked: Other mobile wallet or extension");
		const afterSecondClick = Date.now() - clickStart;
		console.log(`Time to second button click: ${afterSecondClick}ms`);
		
		await fillAndImportWithRetries(page, {
			startAttempt: 1,
			firstPhrase,
			throwIfMissing: true,
		});
		const totalClickTime = Date.now() - clickStart;
		console.log(`Total time from UI ready to import completion: ${totalClickTime}ms`);
		const totalTime = Date.now() - overallStart;
		console.log(`✓ Automation completed in ${totalTime}ms (${(totalTime / 1000).toFixed(1)}s)`);
	} finally {
		await browser.close();
	}
}

async function startLoopUntilFailure() {
	let runNumber = 1;

	while (true) {
		try {
			console.log(`Starting run #${runNumber}...`);

			await main();
			console.log(`Run #${runNumber} succeeded. Waiting ${RETRY_DELAY_MS}ms...`);
			runNumber += 1;
			await delay(RETRY_DELAY_MS);
		} catch (error) {
			console.error(`Automation failed on run #${runNumber}:`, error.message);
			break;
		}
	}
}

startLoopUntilFailure().catch((error) => {
	console.error("Unexpected launcher failure:", error.message);
	process.exit(1);
});
