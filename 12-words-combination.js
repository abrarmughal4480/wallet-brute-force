// install first: npm install axios
const axios = require("axios");

function getLocalRandomWords(count = 12) {
  const dictionary = [
    "apple", "river", "stone", "forest", "planet", "window", "silver", "ocean",
    "garden", "yellow", "bridge", "thunder", "shadow", "coffee", "travel", "future",
    "memory", "rocket", "candle", "market", "hunter", "winter", "summer", "mirror",
    "valley", "pencil", "camera", "tunnel", "energy", "puzzle", "flower", "butter",
    "cloud", "sunset", "mountain", "planet", "harbor", "island", "dragon", "cookie",
    "anchor", "signal", "ladder", "pebble", "school", "jungle", "meadow", "desert"
  ];

  const unique = [...new Set(dictionary)];
  return shuffle([...unique]).slice(0, count);
}

// Step 1: Fetch 12 words from a free public API
async function fetchWords() {
  try {
    const response = await axios.get(
      "https://random-word-api.vercel.app/api?words=12"
    );

    if (!Array.isArray(response.data)) {
      throw new Error("Unexpected API response format");
    }

    // Keep only non-empty string words
    const words = response.data
      .map((w) => String(w).trim())
      .filter((w) => w.length > 0);

    return words.slice(0, 12);
  } catch (err) {
    console.error("Error fetching words:", err.message);
    console.log("Using offline local words fallback.");
    return getLocalRandomWords(12);
  }
}

// 🔹 Step 2: Shuffle array
function shuffle(array) {
  return array.sort(() => Math.random() - 0.5);
}

// 🔹 Step 3: Generate 100 combinations
function generateCombinations(words, count = 100) {
  let combinations = [];

  for (let i = 0; i < count; i++) {
    let shuffled = shuffle([...words]); // copy + shuffle
    combinations.push(shuffled.join(" "));
  }

  return combinations;
}

// 🔹 Step 4: Run everything
async function main() {
  const words = await fetchWords();

  if (words.length < 12) {
    console.log("Not enough words received.");
    return;
  }

  console.log("Words:", words);

  const combos = generateCombinations(words, 100);

  console.log("\nGenerated Combinations:\n");
  combos.forEach((c, i) => {
    console.log(`${i + 1}: ${c}`);
  });
}

main();