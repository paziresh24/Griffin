document.getElementById("origin").textContent = decodeURIComponent(location.hash.slice(1));
const answer = (yes) => chrome.runtime.sendMessage({ type: "confirmAnswer", yes }, () => window.close());
document.getElementById("yes").addEventListener("click", () => answer(true));
document.getElementById("no").addEventListener("click", () => answer(false));
