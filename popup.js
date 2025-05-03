document.addEventListener("DOMContentLoaded", function () {
	// UI State management
	const state = {
		currentTab: "search",
		isScraping: false,
		results: [],
		searchHistory: JSON.parse(localStorage.getItem("searchHistory")) || [],
		exportFields: [
			"title",
			"rating",
			"phone",
			"address",
			"website",
			"email",
			"hours",
			"category",
			"href",
		],
		searchParams: null,
	};

	// DOM elements
	const elements = {
		tabs: document.querySelectorAll(".tab"),
		tabContents: document.querySelectorAll(".tab-content"),
		message: document.getElementById("message"),
		startSearch: document.getElementById("startSearch"),
		startScraping: document.getElementById("startScraping"),
		progressBar: document.getElementById("progressBar"),
		resultsCount: document.getElementById("resultsCount"),
		statusMessage: document.getElementById("statusMessage"),
		resultsTable: document.getElementById("resultsTable"),
		exportCsv: document.getElementById("exportCsv"),
		exportJson: document.getElementById("exportJson"),
		historyList: document.getElementById("historyList"),
		searchQuery: document.getElementById("searchQuery"),
		location: document.getElementById("location"),
		radius: document.getElementById("radius"),
		minRating: document.getElementById("minRating"),
		maxResults: document.getElementById("maxResults"),
		exportFilename: document.getElementById("exportFilename"),
		dataFields: document.querySelectorAll("input[name='dataFields']"),
	};

	// Initialize UI
	initTabs();
	renderHistory();
	updateUI();

	// Event listeners
	elements.startSearch.addEventListener("click", startSearch);
	elements.startScraping.addEventListener("click", startScraping);
	elements.exportCsv.addEventListener("click", () => exportData("csv"));
	elements.exportJson.addEventListener("click", () => exportData("json"));

	// Listen for messages from the content script
	chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
		if (request.type === "SCRAPING_RESULTS") {
			state.results = request.results || [];
			if (state.results.length > 0) {
				showMessage(`Found ${state.results.length} results`, "success");
				renderResults();
				switchToTab("results");
			} else {
				showMessage("No results found", "warning");
			}
			state.isScraping = false;
			updateUI();
		} else if (request.type === "UPDATE_STATUS") {
			elements.statusMessage.textContent = request.status;
		} else if (request.type === "END_OF_RESULTS") {
			elements.startScraping.disabled = false;
			showMessage("Search complete. Ready to scrape.", "success");
			elements.statusMessage.textContent = "Search complete. Ready to scrape.";
			state.isScraping = false;
			updateUI();
			elements.progressBar.style.display = "none";
		} else if (request.type === "SEARCH_ERROR") {
			showMessage(`Error: ${request.message}`, "error");
			elements.statusMessage.textContent = "Error during search.";
			state.isScraping = false;
			updateUI();
			elements.progressBar.style.display = "none";
		}
	});

	// Tab switching
	function initTabs() {
		elements.tabs.forEach((tab) => {
			tab.addEventListener("click", () => {
				elements.tabs.forEach((t) => t.classList.remove("active"));
				elements.tabContents.forEach((c) => c.classList.remove("active"));

				tab.classList.add("active");
				document
					.getElementById(`${tab.dataset.tab}-tab`)
					.classList.add("active");
				state.currentTab = tab.dataset.tab;
			});
		});
	}

	// Start search process
	async function startSearch() {
		if (state.isScraping) return;

		state.searchParams = {
			query: elements.searchQuery.value.trim(),
			location: elements.location.value.trim(),
			radius: elements.radius.value || 10,
			minRating: parseFloat(elements.minRating.value) || 0,
			maxResults: parseInt(elements.maxResults.value) || 5000,
		};

		if (!state.searchParams.query) {
			showMessage("Please enter a search query", "error");
			return;
		}

		state.isScraping = true;
		updateUI();
		showMessage("Starting search...", "info");
		elements.progressBar.style.display = "block";
		elements.statusMessage.textContent = "Navigating to Maps...";

		try {
			// Save to history
			saveToHistory(state.searchParams);

			// Get current active tab
			const [tab] = await chrome.tabs.query({
				active: true,
				currentWindow: true,
			});

			// Navigate to Google Maps with search parameters
			const mapsUrl = buildMapsUrl(state.searchParams);
			await chrome.tabs.update(tab.id, { url: mapsUrl });

			// Wait for page to load
			await new Promise((resolve) => setTimeout(resolve, 3000));

			// Execute script to load all results
			await chrome.scripting.executeScript({
				target: { tabId: tab.id },
				func: loadAllResults,
				args: [state.searchParams.maxResults],
			});

			showMessage("Loading all results...", "info");
			elements.statusMessage.textContent = "Loading all results...";
			state.isScraping = false;
		} catch (error) {
			console.error("Search error:", error);
			showMessage(`Error: ${error.message}`, "error");
			state.isScraping = false;
			updateUI();
			elements.progressBar.style.display = "none";
		}
	}

	// Start scraping process
	async function startScraping() {
		if (state.isScraping) return;
		state.isScraping = true;
		updateUI();
		showMessage("Starting scraping process...", "info");
		elements.progressBar.style.display = "block";
		elements.statusMessage.textContent = "Scraping data...";

		try {
			// Get current active tab
			const [tab] = await chrome.tabs.query({
				active: true,
				currentWindow: true,
			});

			// Execute scraping script
			const response = await chrome.scripting.executeScript({
				target: { tabId: tab.id },
				func: scrapeData,
				args: [state.searchParams],
			});

			if (response && response[0] && response[0].result) {
				state.results = response[0].result;
				if (state.results.length > 0) {
					showMessage(`Found ${state.results.length} results`, "success");
					renderResults();
					switchToTab("results");
				} else {
					showMessage("No results found", "warning");
				}
			}
		} catch (error) {
			console.error("Scraping error:", error);
			showMessage(`Error: ${error.message}`, "error");
		} finally {
			state.isScraping = false;
			updateUI();
			elements.progressBar.style.display = "none";
		}
	}

	// Build Google Maps URL from search parameters
	function buildMapsUrl(params) {
		let url = `https://www.google.com/maps/search/`;
		if (params.query) url += encodeURIComponent(params.query);
		if (params.location) url += `+in+${encodeURIComponent(params.location)}`;
		return url;
	}

	// Function to load all results (injected into page)
	function loadAllResults(maxResults) {
		const resultsPane = document.querySelector('[role="feed"]');
		if (!resultsPane) {
			chrome.runtime.sendMessage({
				type: "SEARCH_ERROR",
				message: "Could not find results container",
			});
			return;
		}

		let previousHeight = 0;
		let sameHeightCount = 0;
		const maxSameHeightAttempts = 3;
		const maxTotalAttempts = 50;
		let totalAttempts = 0;

		const scrollAndCheck = () => {
			totalAttempts++;
			const currentHeight = resultsPane.scrollHeight;
			resultsPane.scrollTop = currentHeight;

			// Check if we've reached the end
			const endMessage = document.querySelector(
				'[role="heading"][aria-level="3"]'
			);
			if (
				endMessage?.textContent.includes(
					"You've reached the end of the list"
				) ||
				totalAttempts >= maxTotalAttempts
			) {
				chrome.runtime.sendMessage({ type: "END_OF_RESULTS" });
				return;
			}

			// Check if scroll height hasn't changed
			if (currentHeight === previousHeight) {
				sameHeightCount++;
				if (sameHeightCount >= maxSameHeightAttempts) {
					chrome.runtime.sendMessage({ type: "END_OF_RESULTS" });
					return;
				}
			} else {
				sameHeightCount = 0;
				previousHeight = currentHeight;
			}

			// Continue scrolling
			setTimeout(scrollAndCheck, 2000);
		};

		scrollAndCheck();
	}

	// Function to scrape data (injected into page)
	function scrapeData(searchParams) {
		const results = [];
		const placeLinks = Array.from(
			document.querySelectorAll('a[href^="https://www.google.com/maps/place"]')
		);

		if (placeLinks.length === 0) {
			chrome.runtime.sendMessage({
				type: "SEARCH_ERROR",
				message: "No place links found",
			});
			return results;
		}

		placeLinks.slice(0, searchParams?.maxResults || 100).forEach((link) => {
			const container =
				link.closest('[jsaction*="mouseover:pane"]') ||
				link.closest('[role="article"]') ||
				link.closest(".THOPZb");

			if (!container) return;

			// Extract title
			const title =
				container.querySelector(".fontHeadlineSmall")?.textContent?.trim() ||
				container.querySelector(".qBF1Pd")?.textContent?.trim() ||
				"";

			// Extract rating and review count
			const ratingElement = container.querySelector('[role="img"]');
			let rating = "";
			if (ratingElement) {
				const ariaLabel = ratingElement.getAttribute("aria-label") || "";
				const ratingMatch = ariaLabel.match(/(\d\.?\d?)\sstars?/);
				if (ratingMatch) rating = ratingMatch[1];
			}

			// Extract phone number
			const phoneRegex = /(\+\d{1,2}\s)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/;
			const phone = container.textContent.match(phoneRegex)?.[0] || "";

			// Extract address
			const address =
				container.querySelector(".W4Efsd:last-child")?.textContent?.trim() ||
				"";

			// Extract website
			let website = "";
			const allLinks = Array.from(container?.querySelectorAll("a[href]") || []);
			const websiteLink = allLinks.find(
				(link) => !link.href.startsWith("https://www.google.com/maps/place/")
			);
			if (websiteLink) {
				website = websiteLink.href;
			}

			// Extract category
			const category =
				container.querySelector(".W4Efsd:nth-child(2)")?.textContent?.trim() ||
				"";

			// Extract hours
			const hours =
				container.querySelector(".W4Efsd:nth-child(3)")?.textContent?.trim() ||
				"";

			const emailRegex = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/;

			const email = container.textContent.match(emailRegex)?.[0] || "";

			results.push({
				title,
				rating,
				phone,
				address,
				website,
				email,
				hours,
				category,
				href: link.href.split("?")[0], // Clean URL
			});
		});

		chrome.runtime.sendMessage({
			type: "SCRAPING_RESULTS",
			results: results,
		});

		return results;
	}

	// Render results to table
	function renderResults() {
		while (elements.resultsTable.firstChild) {
			elements.resultsTable.removeChild(elements.resultsTable.firstChild);
		}

		const selectedFields = Array.from(elements.dataFields)
			.filter((field) => field.checked)
			.map((field) => field.value);

		if (!selectedFields.includes("href")) selectedFields.push("href");

		// Add headers
		const headerRow = document.createElement("tr");
		selectedFields.forEach((field) => {
			const header = document.createElement("th");
			header.textContent = field.charAt(0).toUpperCase() + field.slice(1);
			headerRow.appendChild(header);
		});
		elements.resultsTable.appendChild(headerRow);

		// Add data rows
		state.results.forEach((result) => {
			const row = document.createElement("tr");
			selectedFields.forEach((field) => {
				const cell = document.createElement("td");
				if (field === "href" && result[field]) {
					const link = document.createElement("a");
					link.href = result[field];
					link.textContent = "View";
					link.target = "_blank";
					cell.appendChild(link);
				} else if (field === "website" && result[field]) {
					const link = document.createElement("a");
					link.href = result[field].startsWith("http")
						? result[field]
						: `https://${result[field]}`;
					link.textContent = "Visit";
					link.target = "_blank";
					cell.appendChild(link);
				} else {
					cell.textContent = result[field] || "";
				}
				row.appendChild(cell);
			});
			elements.resultsTable.appendChild(row);
		});

		elements.resultsCount.textContent = `Results: ${state.results.length}`;
	}

	// Export data to CSV or JSON
	function exportData(format) {
		if (state.results.length === 0) {
			showMessage("No results to export", "warning");
			return;
		}

		const selectedFields = Array.from(elements.dataFields)
			.filter((field) => field.checked)
			.map((field) => field.value);

		if (!selectedFields.includes("href")) selectedFields.push("href");

		let filename =
			elements.exportFilename.value.trim() ||
			`maps-data-${new Date().toISOString().slice(0, 10)}`;
		filename = filename.replace(/[^a-z0-9]/gi, "_").toLowerCase();

		const filteredResults = state.results.map((result) => {
			const filtered = {};
			selectedFields.forEach((field) => {
				filtered[field] = result[field] || "";
			});
			return filtered;
		});

		if (format === "csv") {
			const headers = Object.keys(filteredResults[0]);
			const csvRows = [
				headers.join(","),
				...filteredResults.map((row) =>
					headers
						.map((field) => `"${String(row[field] || "").replace(/"/g, '""')}"`)
						.join(",")
				),
			];
			const csv = csvRows.join("\n");
			const blob = new Blob(["\uFEFF" + csv], {
				type: "text/csv;charset=utf-8;",
			});
			downloadFile(blob, `${filename}.csv`);
		} else {
			const json = JSON.stringify(filteredResults, null, 2);
			const blob = new Blob([json], { type: "application/json" });
			downloadFile(blob, `${filename}.json`);
		}

		showMessage(`Exported to ${filename}.${format}`, "success");
	}

	function downloadFile(blob, filename) {
		const url = URL.createObjectURL(blob);
		const link = document.createElement("a");
		link.download = filename;
		link.href = url;
		link.style.display = "none";
		document.body.appendChild(link);
		link.click();
		document.body.removeChild(link);
		URL.revokeObjectURL(url);
	}

	// Search history functions
	function saveToHistory(searchParams) {
		const historyItem = {
			...searchParams,
			timestamp: new Date().toISOString(),
			resultCount: 0,
		};

		state.searchHistory.unshift(historyItem);
		if (state.searchHistory.length > 10) state.searchHistory.pop();
		localStorage.setItem("searchHistory", JSON.stringify(state.searchHistory));
		renderHistory();
	}

	function renderHistory() {
		elements.historyList.innerHTML = "";
		state.searchHistory.forEach((item, index) => {
			const historyItem = document.createElement("div");
			historyItem.className = "history-item";
			historyItem.innerHTML = `
                <strong>${item.query}</strong> in ${
				item.location || "unknown location"
			} (${item.resultCount || 0} results)
                <div class="timestamp">${new Date(
									item.timestamp
								).toLocaleString()}</div>
            `;
			historyItem.addEventListener("click", () => loadFromHistory(index));
			elements.historyList.appendChild(historyItem);
		});
	}

	function loadFromHistory(index) {
		const item = state.searchHistory[index];
		elements.searchQuery.value = item.query;
		elements.location.value = item.location || "";
		elements.radius.value = item.radius || 10;
		elements.minRating.value = item.minRating || 0;
		elements.maxResults.value = item.maxResults || 100;
		switchToTab("search");
		showMessage("Search parameters loaded from history", "info");
	}

	// UI helpers
	function switchToTab(tabName) {
		elements.tabs.forEach((t) => t.classList.remove("active"));
		elements.tabContents.forEach((c) => c.classList.remove("active"));
		const tab = Array.from(elements.tabs).find(
			(t) => t.dataset.tab === tabName
		);
		if (tab) {
			tab.classList.add("active");
			document.getElementById(`${tabName}-tab`).classList.add("active");
			state.currentTab = tabName;
		}
	}

	function showMessage(text, type = "info") {
		elements.message.textContent = text;
		elements.message.className = `message ${type}`;
	}

	function updateUI() {
		elements.startSearch.disabled = state.isScraping;
		elements.startScraping.disabled =
			state.isScraping || state.results.length > 0;
		elements.startSearch.textContent = state.isScraping
			? "Searching..."
			: "Start Search";
		elements.startScraping.textContent = state.isScraping
			? "Scraping..."
			: "Start Scraping";
		elements.exportCsv.disabled =
			state.results.length === 0 || state.isScraping;
		elements.exportJson.disabled =
			state.results.length === 0 || state.isScraping;
		elements.progressBar.style.display = state.isScraping ? "block" : "none";
		elements.progressBar.style.width = state.isScraping ? "100%" : "0%";
	}

	// Initial message
	showMessage("Ready to scrape", "info");
});
