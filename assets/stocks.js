// Curated list of stocks commonly granted (RSU/ESPP) to India-based employees
// of multinationals with India offices. Grouped by exchange/country. The Yahoo
// ticker suffix and the trading currency are what the app needs.
//
// Users are NOT limited to this list — any Country + Symbol works via live
// lookup. This just powers the quick-pick dropdown.
window.STOCKS = [
  // --- United States (USD, no suffix) ---
  { name: "Microsoft", symbol: "MSFT", country: "US", currency: "USD" },
  { name: "Google (Alphabet A)", symbol: "GOOGL", country: "US", currency: "USD" },
  { name: "Amazon", symbol: "AMZN", country: "US", currency: "USD" },
  { name: "Apple", symbol: "AAPL", country: "US", currency: "USD" },
  { name: "Meta Platforms", symbol: "META", country: "US", currency: "USD" },
  { name: "Adobe", symbol: "ADBE", country: "US", currency: "USD" },
  { name: "Salesforce", symbol: "CRM", country: "US", currency: "USD" },
  { name: "NVIDIA", symbol: "NVDA", country: "US", currency: "USD" },
  { name: "Oracle", symbol: "ORCL", country: "US", currency: "USD" },
  { name: "Intel", symbol: "INTC", country: "US", currency: "USD" },
  { name: "Cisco", symbol: "CSCO", country: "US", currency: "USD" },
  { name: "IBM", symbol: "IBM", country: "US", currency: "USD" },
  { name: "Qualcomm", symbol: "QCOM", country: "US", currency: "USD" },
  { name: "Uber", symbol: "UBER", country: "US", currency: "USD" },
  { name: "Walmart", symbol: "WMT", country: "US", currency: "USD" },
  { name: "PayPal", symbol: "PYPL", country: "US", currency: "USD" },
  { name: "ServiceNow", symbol: "NOW", country: "US", currency: "USD" },
  { name: "Visa", symbol: "V", country: "US", currency: "USD" },
  { name: "Mastercard", symbol: "MA", country: "US", currency: "USD" },
  { name: "Micron", symbol: "MU", country: "US", currency: "USD" },
  { name: "Texas Instruments", symbol: "TXN", country: "US", currency: "USD" },
  { name: "American Express", symbol: "AXP", country: "US", currency: "USD" },
  { name: "Goldman Sachs", symbol: "GS", country: "US", currency: "USD" },
  { name: "JPMorgan Chase", symbol: "JPM", country: "US", currency: "USD" },
  { name: "Wells Fargo", symbol: "WFC", country: "US", currency: "USD" },
  { name: "Deloitte (n/a - private)", symbol: "", country: "US", currency: "USD" },

  // --- United Kingdom (GBP, .L on LSE; note some quote in pence GBp) ---
  { name: "HSBC Holdings", symbol: "HSBA.L", country: "UK", currency: "GBP" },
  { name: "AstraZeneca", symbol: "AZN.L", country: "UK", currency: "GBP" },
  { name: "BP", symbol: "BP.L", country: "UK", currency: "GBP" },
  { name: "Barclays", symbol: "BARC.L", country: "UK", currency: "GBP" },
  { name: "Unilever", symbol: "ULVR.L", country: "UK", currency: "GBP" },
  { name: "Vodafone", symbol: "VOD.L", country: "UK", currency: "GBP" },

  // --- Germany (EUR, .DE on Xetra) ---
  { name: "SAP", symbol: "SAP.DE", country: "DE", currency: "EUR" },
  { name: "Siemens", symbol: "SIE.DE", country: "DE", currency: "EUR" },
  { name: "Deutsche Bank", symbol: "DBK.DE", country: "DE", currency: "EUR" },
  { name: "Allianz", symbol: "ALV.DE", country: "DE", currency: "EUR" },
  { name: "BASF", symbol: "BAS.DE", country: "DE", currency: "EUR" },

  // --- France (EUR, .PA on Euronext Paris) ---
  { name: "Capgemini", symbol: "CAP.PA", country: "FR", currency: "EUR" },
  { name: "TotalEnergies", symbol: "TTE.PA", country: "FR", currency: "EUR" },
  { name: "Schneider Electric", symbol: "SU.PA", country: "FR", currency: "EUR" },
  { name: "Airbus", symbol: "AIR.PA", country: "FR", currency: "EUR" },
  { name: "Sanofi", symbol: "SAN.PA", country: "FR", currency: "EUR" },

  // --- Netherlands / Switzerland (EUR / CHF) ---
  { name: "ASML", symbol: "ASML.AS", country: "NL", currency: "EUR" },
  { name: "Nestle", symbol: "NESN.SW", country: "CH", currency: "CHF" },
  { name: "Novartis", symbol: "NOVN.SW", country: "CH", currency: "CHF" },
  { name: "Roche", symbol: "ROG.SW", country: "CH", currency: "CHF" },

  // --- Australia (AUD, .AX on ASX) ---
  { name: "Atlassian (US-listed)", symbol: "TEAM", country: "US", currency: "USD" },
  { name: "Commonwealth Bank", symbol: "CBA.AX", country: "AU", currency: "AUD" },
  { name: "BHP Group", symbol: "BHP.AX", country: "AU", currency: "AUD" },
  { name: "Macquarie Group", symbol: "MQG.AX", country: "AU", currency: "AUD" },
  { name: "Wisetech Global", symbol: "WTC.AX", country: "AU", currency: "AUD" },

  // --- Japan (JPY, .T on Tokyo SE) ---
  { name: "Toyota Motor", symbol: "7203.T", country: "JP", currency: "JPY" },
  { name: "Sony Group", symbol: "6758.T", country: "JP", currency: "JPY" },
  { name: "Hitachi", symbol: "6501.T", country: "JP", currency: "JPY" },
  { name: "Rakuten", symbol: "4755.T", country: "JP", currency: "JPY" },
  { name: "SoftBank Group", symbol: "9984.T", country: "JP", currency: "JPY" },
].filter((s) => s.symbol);

// Map a country/exchange to the SBI currency code used for TT BUY conversion.
window.COUNTRY_CURRENCY = {
  US: "USD",
  UK: "GBP",
  DE: "EUR",
  FR: "EUR",
  NL: "EUR",
  CH: "CHF",
  AU: "AUD",
  JP: "JPY",
  EU: "EUR",
};
