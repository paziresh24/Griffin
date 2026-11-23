(function () {
  // Sync theme with main landing app
  var saved = localStorage.getItem("griffin-site-theme");
  if (saved === "dark" || saved === "light") {
    document.documentElement.setAttribute("data-theme", saved);
  }

  // 1) Top reading progress bar
  var bar = document.createElement("div");
  bar.style.cssText =
    "position:fixed;top:0;left:0;right:0;height:3px;z-index:9999;background:transparent;pointer-events:none;";
  var fill = document.createElement("div");
  fill.style.cssText =
    "height:100%;width:0%;background:linear-gradient(90deg,#e05a1e,#f59e0b);transition:width 80ms linear;";
  bar.appendChild(fill);
  document.body.appendChild(bar);

  function updateProgress() {
    var doc = document.documentElement;
    var max = doc.scrollHeight - window.innerHeight;
    var pct = max > 0 ? Math.min(100, Math.max(0, (window.scrollY / max) * 100)) : 0;
    fill.style.width = pct.toFixed(1) + "%";
  }
  window.addEventListener("scroll", updateProgress, { passive: true });
  updateProgress();

  // 2) Auto-build floating interactive TOC from h2 headings
  var headings = Array.from(document.querySelectorAll("article h2, main h2"));
  if (headings.length >= 2) {
    var toc = document.createElement("nav");
    toc.setAttribute("aria-label", "فهرست مطالب");
    toc.style.cssText =
      "margin:1.5rem 0 2rem;padding:1rem 1.25rem;border-radius:16px;border:1px solid var(--border,rgba(15,23,42,.1));background:var(--surface,#fff);box-shadow:0 8px 24px -16px rgba(15,23,42,.12);";
    var title = document.createElement("div");
    title.textContent = "در این مقاله می‌خوانید";
    title.style.cssText =
      "font-size:12px;font-weight:800;color:var(--accent,#e05a1e);margin-bottom:.65rem;letter-spacing:-0.01em;";
    toc.appendChild(title);
    var list = document.createElement("div");
    list.style.cssText = "display:flex;flex-wrap:wrap;gap:8px;";
    headings.forEach(function (h, i) {
      if (!h.id) h.id = "sec-" + (i + 1);
      var a = document.createElement("a");
      a.href = "#" + h.id;
      a.textContent = h.textContent.trim();
      a.style.cssText =
        "font-size:12.5px;font-weight:600;padding:6px 12px;border-radius:10px;border:1px solid var(--border,rgba(15,23,42,.1));color:var(--fg,#0b1220);text-decoration:none;transition:all 180ms ease;background:var(--bg-subtle,#f3f4f8);";
      a.addEventListener("mouseenter", function () {
        a.style.borderColor = "#e05a1e";
        a.style.color = "#e05a1e";
      });
      a.addEventListener("mouseleave", function () {
        a.style.borderColor = "var(--border,rgba(15,23,42,.1))";
        a.style.color = "var(--fg,#0b1220)";
      });
      list.appendChild(a);
    });
    toc.appendChild(list);
    var firstH2 = headings[0];
    if (firstH2 && firstH2.parentNode) {
      firstH2.parentNode.insertBefore(toc, firstH2);
    }
  }

  // 3) Smooth scroll reveal on article sections & cards
  var reveals = document.querySelectorAll("article h2, article pre, article .callout, article .diagram, article table, article blockquote");
  if ("IntersectionObserver" in window) {
    var io = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) {
            entry.target.style.opacity = "1";
            entry.target.style.transform = "translateY(0)";
            io.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.08 }
    );
    reveals.forEach(function (el) {
      el.style.opacity = "0";
      el.style.transform = "translateY(14px)";
      el.style.transition = "opacity 420ms cubic-bezier(.22,1,.36,1), transform 420ms cubic-bezier(.22,1,.36,1)";
      io.observe(el);
    });
  }

  // 4) Add live Copy button on every <pre> code block
  document.querySelectorAll("pre").forEach(function (pre) {
    pre.style.position = "relative";
    var btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = "کپی";
    btn.style.cssText =
      "position:absolute;top:10px;left:10px;font-size:11px;font-weight:700;padding:4px 10px;border-radius:8px;border:1px solid rgba(255,255,255,.18);background:rgba(255,255,255,.1);color:#fff;cursor:pointer;";
    btn.addEventListener("click", function () {
      var code = pre.querySelector("code") ? pre.querySelector("code").innerText : pre.innerText;
      navigator.clipboard.writeText(code).then(function () {
        btn.textContent = "کپی شد ✓";
        setTimeout(function () { btn.textContent = "کپی"; }, 1600);
      });
    });
    pre.appendChild(btn);
  });
})();
