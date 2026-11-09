import * as THREE from "https://cdn.jsdelivr.net/npm/three@0.170.0/build/three.module.js";
import { MENUS, UI, findDish, dishCount } from "./menus.js";
import { createDishModel } from "./models.js";

const app = document.querySelector("#app");

let generation = 0;
let active = null;

function esc(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function route() {
  const params = new URLSearchParams(location.search);
  const menu = params.get("menu");
  const plato = params.get("plato");
  return {
    menu: menu === "pe" || menu === "br" ? menu : null,
    plato: plato || null,
  };
}

function appHref(menu, plato) {
  const url = new URL(location.href);
  url.searchParams.set("menu", menu);
  if (plato) url.searchParams.set("plato", plato);
  else url.searchParams.delete("plato");
  url.hash = "";
  return `${url.pathname}${url.search}`;
}

function slugUrl(code) {
  const url = new URL(location.href);
  let path = url.pathname;
  if (path.endsWith("/index.html")) path = path.slice(0, -"/index.html".length);
  else if (path.endsWith("index.html")) path = path.slice(0, -"index.html".length);
  if (!path.endsWith("/")) path += "/";
  url.pathname = `${path}${code}/`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

function price(menu, amount) {
  return `${UI[menu].currency} ${amount}`;
}

function render() {
  const { menu, plato } = route();
  const copy = menu ? UI[menu] : null;
  document.documentElement.lang = copy ? copy.htmlLang : "es";
  document.title = copy ? `MESA — ${copy.carta}` : "MESA — Carta aumentada";

  const found = menu && plato ? findDish(menu, plato) : null;
  const sameDish = found && active && active.menu === menu && active.dishId === found.dish.id && app.querySelector(".viewer");
  if (sameDish) return;

  stopViewer();

  if (!menu) app.innerHTML = landing();
  else if (plato && !found) app.innerHTML = missing(menu);
  else if (found) app.innerHTML = viewerMarkup(menu, found.section, found.dish);
  else app.innerHTML = carta(menu);

  window.scrollTo(0, 0);
  if (found) mountViewer(menu, found.dish);
}

function landing() {
  return `
    <div class="screen screen-wide">
      <header class="mast mast-light">
        <p class="brand">MESA</p>
        <p class="brand-sub">carta aumentada</p>
        <h1>Dos cartas, una misma mesa.</h1>
        <p class="lede">Un QR abre la carta peruana y el otro, el cardápio brasileiro. El idioma va en el slug del enlace: <strong>/pe/</strong> y <strong>/br/</strong>. Dois QR, dois idiomas, o mesmo aplicativo.</p>
      </header>
      <div class="picks">
        ${pickCard("pe")}
        ${pickCard("br")}
      </div>
      <section class="sheet qr-block" aria-labelledby="qr-title">
        <h2 id="qr-title">Enlaces para los QR</h2>
        <p>Pega cada URL en un generador de códigos. Los dos abren esta misma aplicación.</p>
        ${urlRow("pe", "Perú")}
        ${urlRow("br", "Brasil")}
      </section>
    </div>
  `;
}

function pickCard(menu) {
  const copy = UI[menu];
  const names = MENUS[menu].sections
    .flatMap((section) => section.dishes)
    .slice(0, 3)
    .map((dish) => dish.name)
    .join(" · ");
  return `
    <a class="sheet pick" data-nav data-accent="${menu}" href="${esc(appHref(menu))}">
      <p class="pick-kicker">${esc(copy.language)}</p>
      <h2>${esc(copy.carta)}</h2>
      <p>${esc(copy.kitchen)} · ${dishCount(menu)} ${menu === "pe" ? "platos" : "pratos"}</p>
      <p class="pick-names">${esc(names)}</p>
      <span class="pick-go">${menu === "pe" ? "Abrir carta" : "Abrir cardápio"}</span>
    </a>
  `;
}

function urlRow(menu, label) {
  const url = slugUrl(menu);
  return `
    <div class="url-row">
      <strong>${esc(label)}</strong>
      <code>${esc(url)}</code>
      <button class="copy" type="button" data-action="copy-slug" data-code="${menu}" data-label="Copiar">Copiar</button>
    </div>
  `;
}

function carta(menu) {
  const copy = UI[menu];
  const sections = MENUS[menu].sections.map((section) => `
    <section class="menu-section" aria-labelledby="sec-${section.id}">
      <h2 class="section-label" id="sec-${section.id}">${esc(section.title)}</h2>
      <ul class="dishes">
        ${section.dishes.map((dish) => `
          <li>
            <a class="dish" data-nav href="${esc(appHref(menu, dish.id))}">
              <span class="dish-name">${esc(dish.name)}</span>
              <span class="dish-price">${esc(price(menu, dish.price))}</span>
              <span class="dish-blurb">${esc(dish.blurb)}</span>
            </a>
          </li>
        `).join("")}
      </ul>
    </section>
  `).join("");

  return `
    <div class="screen">
      <article class="sheet sheet-pad" data-accent="${menu}">
        <header class="mast">
          <p class="brand">MESA</p>
          <p class="brand-sub">${esc(copy.brandSub)}</p>
          <div class="rule" aria-hidden="true"></div>
          <h1>${esc(copy.carta)}</h1>
          <p class="kitchen">${esc(copy.kitchen)}</p>
          <p class="hint">${esc(copy.hint)}</p>
        </header>
        ${sections}
        <footer class="sheet-foot">
          <p>${esc(copy.country)}</p>
          <a data-nav href="${esc(appHref(copy.otherHref))}">${esc(copy.otherLabel)}</a>
        </footer>
      </article>
    </div>
  `;
}

function viewerMarkup(menu, section, dish) {
  const copy = UI[menu];
  const nutrients = copy.nutrients.map((item) => `
    <div>
      <dt>${esc(item.label)}</dt>
      <dd>${esc(dish.nutrition[item.key])} ${esc(item.unit)}</dd>
    </div>
  `).join("");

  return `
    <section class="viewer" data-accent="${menu}">
      <video class="viewer-video" autoplay playsinline muted></video>
      <canvas class="viewer-canvas" data-model="${esc(dish.id)}" aria-label="${esc(dish.name)}"></canvas>
      <a class="viewer-back" data-nav href="${esc(appHref(menu))}">
        <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M10 3 L5 8 L10 13" fill="none" stroke="currentColor" stroke-width="1.6"></path></svg>
        ${esc(copy.back)}
      </a>
      <p class="viewer-hint">${esc(copy.spinHint)}</p>
      <p class="viewer-alert" hidden></p>
      <div class="viewer-card">
        <div class="viewer-heading">
          <h1>${esc(dish.name)}</h1>
          <p class="price-lg">${esc(price(menu, dish.price))}</p>
        </div>
        <p class="portion">${esc(dish.portion)} · ${esc(section.title)}</p>
        <dl class="nutrition">${nutrients}</dl>
        <p class="viewer-allergens">${esc(copy.allergensTitle)}: ${dish.allergens.length ? esc(dish.allergens.join(", ")) : esc(copy.noAllergens)}</p>
      </div>
    </section>
  `;
}

function missing(menu) {
  const copy = UI[menu];
  return `
    <div class="screen">
      <article class="sheet sheet-pad" data-accent="${menu}">
        <h1 class="dish-title">${esc(copy.missingTitle)}</h1>
        <p class="desc">${esc(copy.missingBody)}</p>
        <p class="desc"><a data-nav href="${esc(appHref(menu))}">${esc(copy.back)}</a></p>
      </article>
    </div>
  `;
}

function cameraErrorMessage(error, copy) {
  if (!window.isSecureContext) return copy.cameraInsecure;
  if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== "function") {
    return copy.cameraUnavailable;
  }
  const name = error && error.name;
  if (name === "NotAllowedError" || name === "PermissionDeniedError") return copy.cameraDenied;
  if (name === "NotFoundError" || name === "DevicesNotFoundError" || name === "OverconstrainedError") {
    return copy.cameraMissing;
  }
  return copy.cameraFailed;
}

function stopViewer() {
  generation += 1;
  const current = active;
  active = null;
  if (!current) return;
  cancelAnimationFrame(current.frame);
  current.stream?.getTracks().forEach((track) => track.stop());
  current.observer?.disconnect();
  window.removeEventListener("pointerup", current.onUp);
  current.renderer?.dispose();
}

function showViewerAlert(text) {
  const alert = app.querySelector(".viewer-alert");
  if (!alert) return;
  alert.hidden = false;
  alert.textContent = text;
}

function mountViewer(menu, dish) {
  const session = generation;
  const copy = UI[menu];
  const video = app.querySelector(".viewer-video");
  const canvas = app.querySelector(".viewer-canvas");
  if (!video || !canvas) return;

  video.playsInline = true;
  let request = null;
  if (navigator.mediaDevices && typeof navigator.mediaDevices.getUserMedia === "function") {
    request = navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: { ideal: "environment" },
        width: { ideal: 1280 },
        height: { ideal: 720 },
      },
    });
  } else {
    showViewerAlert(cameraErrorMessage(null, copy));
  }

  const view = setupThree(canvas, dish.id, session);
  active = { menu, dishId: dish.id, stream: null, ...view };
  view.start();

  request?.then((stream) => {
    if (generation !== session || !active) {
      stream.getTracks().forEach((track) => track.stop());
      return;
    }
    active.stream = stream;
    video.srcObject = stream;
    video.play().catch(() => {});
  }).catch((error) => {
    if (generation !== session) return;
    showViewerAlert(cameraErrorMessage(error, copy));
  });
}

function setupThree(canvas, dishId, session) {
  const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
  renderer.setClearColor(0x000000, 0);
  if (THREE.SRGBColorSpace) renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(34, 1, 0.1, 30);
  camera.position.set(0.85, 2.7, 3.7);
  camera.lookAt(0, -0.55, 0);

  scene.add(new THREE.HemisphereLight(0xfff6ea, 0x2a211c, 2.2));
  const key = new THREE.DirectionalLight(0xffffff, 2.6);
  key.position.set(2.4, 4.2, 2.2);
  scene.add(key);
  const fill = new THREE.DirectionalLight(0xffc9a0, 0.7);
  fill.position.set(-2.8, 1.4, -1.6);
  scene.add(fill);

  const model = createDishModel(dishId);
  scene.add(model);

  const shadow = new THREE.Mesh(
    new THREE.CircleGeometry(1.2, 40),
    new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.32, depthWrite: false })
  );
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.y = 0.01;
  scene.add(shadow);

  function resize() {
    const width = canvas.clientWidth || 1;
    const height = canvas.clientHeight || 1;
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  }
  resize();
  const observer = new ResizeObserver(resize);
  observer.observe(canvas);

  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  let dragging = false;
  let lastX = 0;
  canvas.addEventListener("pointerdown", (event) => {
    dragging = true;
    lastX = event.clientX;
    canvas.setPointerCapture?.(event.pointerId);
  });
  canvas.addEventListener("pointermove", (event) => {
    if (!dragging) return;
    model.rotation.y += (event.clientX - lastX) * 0.012;
    lastX = event.clientX;
  });
  function onUp() {
    dragging = false;
  }
  window.addEventListener("pointerup", onUp);

  let frame = 0;
  function tick() {
    if (generation !== session) return;
    if (!dragging && !reduceMotion) model.rotation.y += 0.005;
    renderer.render(scene, camera);
    frame = requestAnimationFrame(tick);
    if (active) active.frame = frame;
  }

  return {
    renderer,
    observer,
    onUp,
    get frame() {
      return frame;
    },
    start() {
      frame = requestAnimationFrame(tick);
    },
  };
}

async function copySlug(button) {
  const url = slugUrl(button.dataset.code);
  const label = button.dataset.label || "Copiar";
  const code = button.parentElement?.querySelector("code");
  try {
    await navigator.clipboard.writeText(url);
    button.textContent = "Copiado";
  } catch {
    if (code) {
      const range = document.createRange();
      range.selectNodeContents(code);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    }
    button.textContent = "Selecciona";
  }
  window.setTimeout(() => {
    button.textContent = label;
  }, 1600);
}

function onClick(event) {
  const nav = event.target.closest("a[data-nav]");
  if (nav) {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
    event.preventDefault();
    history.pushState({}, "", nav.href);
    render();
    return;
  }

  const action = event.target.closest("[data-action]");
  if (action?.dataset.action === "copy-slug") copySlug(action);
}

app.addEventListener("click", onClick);
window.addEventListener("popstate", render);
window.addEventListener("pagehide", stopViewer);
render();
