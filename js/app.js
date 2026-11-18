import * as THREE from "three";
import {
  MENUS,
  UI,
  findDish,
  dishCount,
  localizedDish,
  localizedSection,
  localizedKitchen,
  localizedMissingBody,
  localizedMissingTitle,
} from "./menus.js";
import { loadDishModel, prefetchDishModels, isDishModelReady } from "./models.js";

const app = document.querySelector("#app");

const RETICLE_SCAN = 0xffcc33;
const RETICLE_READY = 0x3ddc6a;
const RETICLE_BLOCK = 0xe05a3c;
/** Vista previa (antes de escanear). */
const DISH_SCALE_PREVIEW = 1;
/** Tamaño anclado en la mesa durante AR. */
const DISH_SCALE_AR = 0.26;
const DISH_SCALE_SHADOW_REF = DISH_SCALE_PREVIEW;
const VIEWER_LIGHT_STUDIO = { hemi: 5.4, key: 5.8, fill: 3.2, rim: 2.1, ambient: 1.4, exposure: 1.45 };
const VIEWER_LIGHT_AR = { hemi: 5.4, key: 5.8, fill: 3.2, rim: 2.1, ambient: 1.4, exposure: 1.45 };
/** Distancia extra para que la mesa no se coma el plato; una mano sí lo tapa. */
const OCCLUSION_BIAS_M = 0.12;

const OCCLUSION_VERT_DECL = "varying float vOcclusionDepth;";
const OCCLUSION_VERT_SET = "vOcclusionDepth = -mvPosition.z;";
const OCCLUSION_FRAG_DECL = `
varying float vOcclusionDepth;
uniform sampler2D uOcclusionDepth;
uniform float uOcclusionActive;
uniform float uOcclusionMetersInRed;
uniform float uOcclusionRawToMeters;
uniform float uOcclusionPack;
uniform mat4 uOcclusionViewToDepth;
uniform vec4 uOcclusionViewport;
uniform float uOcclusionBias;
`;
const OCCLUSION_FRAG_BODY = `
if (uOcclusionActive > 0.5) {
  vec2 occNdc = vec2(
    (gl_FragCoord.x - uOcclusionViewport.x) / max(uOcclusionViewport.z, 1.0),
    1.0 - (gl_FragCoord.y - uOcclusionViewport.y) / max(uOcclusionViewport.w, 1.0)
  );
  vec2 occUv = (uOcclusionViewToDepth * vec4(occNdc, 0.0, 1.0)).xy;
  if (occUv.x >= 0.0 && occUv.y >= 0.0 && occUv.x <= 1.0 && occUv.y <= 1.0) {
    vec4 occPacked = texture2D(uOcclusionDepth, occUv);
    float realMeters = uOcclusionMetersInRed > 0.5
      ? occPacked.r
      : (uOcclusionPack > 0.5 ? dot(occPacked.ra, vec2(65280.0, 255.0)) : occPacked.r) * uOcclusionRawToMeters;
    if (realMeters > 0.12 && realMeters < 4.0 && vOcclusionDepth - realMeters > uOcclusionBias) discard;
  }
}
`;

const _hitPos = new THREE.Vector3();
const _hitQuat = new THREE.Quaternion();
const _hitScale = new THREE.Vector3();
const _hitEuler = new THREE.Euler();
const _searchPos = new THREE.Vector3();
const _searchQuat = new THREE.Quaternion();
const _viewFromDepth = new THREE.Matrix4();
const _eyeWorld = new THREE.Matrix4();
const _pinPos = new THREE.Vector3();
const _box = new THREE.Box3();
const _boxSize = new THREE.Vector3();
const _ndc = new THREE.Vector2();
const _raycaster = new THREE.Raycaster();
const _rayOrigin = new THREE.Vector3();
const _rayDir = new THREE.Vector3();
const _rayMatrix = new THREE.Matrix4();

let generation = 0;
let active = null;
let arSupport = null;
/** Platos anclados al mundo real. Sobreviven al volver a la carta mientras la sesión AR sigue abierta. */
const world = {
  menu: null,
  pinned: [],
};
/** Cola de platos a colocar en AR, en orden de selección. */
const placeQueue = [];
let queueSeq = 0;
let pickMode = false;
let pickedIds = [];
let holdTimer = 0;
let holdFired = false;

function queryAR() {
  if (arSupport) return arSupport;
  arSupport = (async () => {
    if (!navigator.xr || typeof navigator.xr.isSessionSupported !== "function") return false;
    try {
      return await navigator.xr.isSessionSupported("immersive-ar");
    } catch {
      return false;
    }
  })();
  return arSupport;
}

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
    pedido: params.has("pedido"),
  };
}

function appHref(menu, plato, pedido = false) {
  const url = new URL(location.href);
  url.searchParams.set("menu", menu);
  if (pedido) {
    url.searchParams.set("pedido", "1");
    url.searchParams.delete("plato");
  } else if (plato) {
    url.searchParams.set("plato", plato);
    url.searchParams.delete("pedido");
  } else {
    url.searchParams.delete("plato");
    url.searchParams.delete("pedido");
  }
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

const CART_KEY = "mesa-cart";
let cartItems = null;

function readCart() {
  if (cartItems) return cartItems;
  try {
    const data = JSON.parse(sessionStorage.getItem(CART_KEY) || "{}");
    cartItems = Array.isArray(data.items) ? data.items : [];
  } catch {
    cartItems = [];
  }
  return cartItems;
}

function writeCart(items) {
  cartItems = items;
  try {
    sessionStorage.setItem(CART_KEY, JSON.stringify({ items }));
  } catch {
    /* El pedido sigue en memoria si el navegador bloquea el almacenamiento. */
  }
}

function cartQty(menu, dishId) {
  const item = readCart().find((entry) => entry.menu === menu && entry.id === dishId);
  return item ? item.qty : 0;
}

function addToCart(menu, dishId) {
  const items = readCart();
  const item = items.find((entry) => entry.menu === menu && entry.id === dishId);
  if (item) item.qty += 1;
  else items.push({ menu, id: dishId, qty: 1 });
  writeCart(items);
  return item ? item.qty : 1;
}

function setCartQty(menu, dishId, qty) {
  const items = readCart().filter((entry) => !(entry.menu === menu && entry.id === dishId));
  if (qty > 0) items.push({ menu, id: dishId, qty });
  writeCart(items);
  return items;
}

function cartForMenu(menu) {
  return readCart().filter((entry) => entry.menu === menu);
}

function cartItemCount(menu) {
  return cartForMenu(menu).reduce((sum, entry) => sum + entry.qty, 0);
}

function cartSubtotal(menu) {
  return cartForMenu(menu).reduce((sum, entry) => {
    const found = findDish(menu, entry.id);
    return sum + (found ? found.dish.price * entry.qty : 0);
  }, 0);
}

function clearCartForMenu(menu) {
  writeCart(readCart().filter((entry) => entry.menu !== menu));
}

let toastTimer = 0;

function showToast(message) {
  let toast = document.querySelector(".mesa-toast");
  if (!toast) {
    toast = document.createElement("p");
    toast.className = "mesa-toast";
    toast.setAttribute("role", "status");
    toast.hidden = true;
    document.body.appendChild(toast);
  }
  toast.textContent = message;
  toast.hidden = false;
  toast.classList.add("is-visible");
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    toast.classList.remove("is-visible");
    toast.hidden = true;
  }, 2400);
}

function addedLabel(copy, qty) {
  return copy.added.replace("{n}", String(qty));
}

function paintAddButton(button, qty) {
  const count = button.querySelector(".viewer-add-count");
  if (!count) return;
  const copy = copyOf(button.dataset.menu);
  count.hidden = qty < 1;
  count.textContent = qty > 0 ? String(qty) : "";
  button.classList.toggle("is-added", qty > 0);
  button.setAttribute("aria-label", qty > 0 ? addedLabel(copy, qty) : copy.add);
}

function tableLabel() {
  const raw = new URLSearchParams(location.search).get("mesa") || "01";
  const clean = raw.replace(/[^\dA-Za-z-]/g, "").slice(0, 4);
  if (!clean) return "01";
  return /^\d+$/.test(clean) ? clean.padStart(2, "0") : clean;
}

const LANG_KEY = "mesa-lang";

function readLangs() {
  try {
    const data = JSON.parse(sessionStorage.getItem(LANG_KEY) || "{}");
    return data && typeof data === "object" ? data : {};
  } catch {
    return {};
  }
}

function menuLang(menu) {
  const saved = readLangs()[menu];
  if (saved === "es" || saved === "pt") return saved;
  return menu === "br" ? "pt" : "es";
}

function setMenuLang(menu, lang) {
  const all = readLangs();
  all[menu] = lang;
  try {
    sessionStorage.setItem(LANG_KEY, JSON.stringify(all));
  } catch {
    /* El idioma sigue en memoria durante esta visita. */
  }
}

function otherMenuLabel(menu, lang) {
  if (menu === "pe") return lang === "pt" ? "Cardápio brasileiro" : "Menú brasileño";
  return lang === "pt" ? "Cardápio peruano" : "Carta peruana";
}

function copyOf(menu) {
  const lang = menuLang(menu);
  const pack = lang === "pt" ? UI.br : UI.pe;
  const own = UI[menu];
  return {
    ...pack,
    currency: own.currency,
    restaurant: own.restaurant,
    country: own.country,
    language: lang === "pt" ? "Português" : "Español",
    otherHref: own.otherHref,
    otherLabel: otherMenuLabel(menu, lang),
    kitchen: localizedKitchen(menu, lang),
    missingTitle: localizedMissingTitle(menu, lang),
    missingBody: localizedMissingBody(menu, lang),
    htmlLang: lang === "pt" ? "pt-BR" : "es-PE",
  };
}

function textDish(menu, dish) {
  return localizedDish(menu, dish, menuLang(menu));
}

function textSection(menu, section) {
  return localizedSection(menu, section, menuLang(menu));
}

function langSwitch(menu) {
  const lang = menuLang(menu);
  const copy = copyOf(menu);
  const options = [
    ["es", "Español"],
    ["pt", "Português"],
  ];
  return `
    <div class="lang-switch" role="group" aria-label="${esc(copy.langAria)}">
      ${options.map(([code, name]) => `
        <button class="lang-btn${lang === code ? " is-on" : ""}" type="button" data-action="set-lang" data-menu="${esc(menu)}" data-lang="${code}" aria-pressed="${lang === code ? "true" : "false"}">${name}</button>
      `).join("")}
    </div>
  `;
}

function resetPicks() {
  pickMode = false;
  pickedIds = [];
  placeQueue.length = 0;
  window.clearTimeout(holdTimer);
  holdFired = false;
}

function makeQueueItem(menu, id) {
  queueSeq += 1;
  return { menu, id, token: queueSeq };
}

function setPlaceQueue(items) {
  placeQueue.length = 0;
  for (const item of items) placeQueue.push(item);
}

function dequeueToken(token) {
  const idx = placeQueue.findIndex((item) => item.token === token);
  if (idx >= 0) placeQueue.splice(idx, 1);
}

function dequeueCurrent(view) {
  if (view?.queueItem) dequeueToken(view.queueItem.token);
  if (view) view.queueItem = null;
}

function placeQueueLabel(copy) {
  const n = pickedIds.length;
  if (n > 1) return copy.placeQueueN.replace("{n}", String(n));
  return copy.placeQueue;
}

function shellState() {
  const { menu, plato, pedido } = route();
  const found = menu && plato ? findDish(menu, plato) : null;
  return {
    pedido,
    found: found
      ? { dish: textDish(menu, found.dish), section: textSection(menu, found.section) }
      : null,
    missing: Boolean(plato && !found),
  };
}

function render() {
  const { menu, pedido } = route();
  const copy = menu ? copyOf(menu) : null;
  document.documentElement.lang = copy ? copy.htmlLang : "es";
  document.title = copy
    ? pedido
      ? `MESA — ${copy.orderTitle}`
      : `MESA — ${copy.carta}`
    : "MESA — Carta aumentada";

  if (!menu) {
    resetPicks();
    stopViewer();
    app.innerHTML = landing();
    window.scrollTo(0, 0);
    return;
  }

  const state = shellState();
  if (active && active.menu === menu && app.querySelector(".viewer")) {
    active.uiLang = menuLang(menu);
    paintShell(menu, state);
    return;
  }

  resetPicks();
  stopViewer();
  app.innerHTML = shellMarkup(menu);
  mountShell(menu);
  paintShell(menu, state);
  window.scrollTo(0, 0);

  if (state.found && !pedido) {
    setPlaceQueue([makeQueueItem(menu, state.found.dish.id)]);
    history.replaceState({}, "", appHref(menu));
  }
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
  const copy = copyOf(menu);
  const names = MENUS[menu].sections
    .flatMap((section) => section.dishes)
    .slice(0, 3)
    .map((dish) => textDish(menu, dish).name)
    .join(" · ");
  return `
    <a class="sheet pick" data-nav data-accent="${menu}" href="${esc(appHref(menu))}">
      <p class="pick-kicker">${esc(copy.language)}</p>
      <h2>${esc(copy.carta)}</h2>
      <p>${esc(copy.kitchen)} · ${dishCount(menu)} ${esc(copy.pickCount)}</p>
      <p class="pick-names">${esc(names)}</p>
      <span class="pick-go">${esc(copy.pickOpen)}</span>
    </a>
  `;
}

function urlRow(menu, label) {
  const copy = copyOf(menu);
  const url = slugUrl(menu);
  return `
    <div class="url-row">
      <strong>${esc(label)}</strong>
      <code>${esc(url)}</code>
      <button class="copy" type="button" data-action="copy-slug" data-code="${menu}" data-label="${esc(copy.copyUrl)}" data-done="${esc(copy.copyDone)}" data-select="${esc(copy.copySelect)}">${esc(copy.copyUrl)}</button>
    </div>
  `;
}

function carta(menu) {
  const copy = copyOf(menu);
  const picking = pickMode;
  const live = Boolean(active?.session);
  const arHidden = active?.arReady === false || live;
  const sections = MENUS[menu].sections.map((section) => {
    const title = textSection(menu, section).title;
    return `
    <section class="menu-section" aria-labelledby="sec-${section.id}">
      <h2 class="section-label" id="sec-${section.id}">${esc(title)}</h2>
      <ul class="dishes">
        ${section.dishes.map((item) => {
          const dish = textDish(menu, item);
          const picked = pickedIds.includes(item.id);
          return `
          <li>
            <button class="dish${picked ? " is-picked" : ""}" type="button" data-pick-dish data-menu="${esc(menu)}" data-dish="${esc(item.id)}">
              <span class="dish-name">${esc(dish.name)}</span>
              <span class="dish-price">${esc(price(menu, dish.price))}</span>
              <span class="dish-blurb">${esc(dish.blurb)}</span>
            </button>
          </li>
        `;
        }).join("")}
      </ul>
    </section>
  `;
  }).join("");

  return `
    <div class="screen">
      <article class="sheet sheet-pad menu-card${picking ? " is-picking" : ""}" data-accent="${menu}">
        <header class="mast menu-mast">
          <p class="resto">${esc(copy.restaurant)}</p>
          <p class="brand">MESA ${esc(tableLabel())}</p>
          <div class="flourish" aria-hidden="true"><span></span></div>
          <h1>${esc(copy.carta)}</h1>
          <p class="kitchen">${esc(copy.kitchen)}</p>
          ${langSwitch(menu)}
          <p class="hint">${esc(copy.hint)}</p>
        </header>
        ${sections}
        ${!picking && placeQueue.length ? `
        <div class="place-bar">
          <button class="ar-btn" type="button" data-action="resume-queue">${esc(copy.placeQueueN.replace("{n}", String(placeQueue.length)))}</button>
        </div>` : ""}
        <div class="menu-actions"${picking ? " hidden" : ""}>
          <button class="ar-btn" type="button" data-action="start-ar"${arHidden ? " hidden" : ""}>${esc(copy.scan)}</button>
          <button class="order-btn" type="button" data-action="view-order" data-menu="${esc(menu)}">
            <span>${esc(copy.viewOrder)}</span>
            ${cartItemCount(menu) ? `<span class="order-badge" aria-hidden="true">${cartItemCount(menu)}</span>` : ""}
          </button>
        </div>
      </article>
    </div>
  `;
}

function pedidoView(menu) {
  const copy = copyOf(menu);
  const items = cartForMenu(menu);
  const lines = items.map((entry) => {
    const found = findDish(menu, entry.id);
    if (!found) return "";
    const dish = textDish(menu, found.dish);
    const lineTotal = dish.price * entry.qty;
    return `
      <li class="order-line" data-menu="${esc(menu)}" data-dish="${esc(dish.id)}">
        <div class="order-line-main">
          <span class="order-line-name">${esc(dish.name)}</span>
          <span class="order-line-price">${esc(price(menu, lineTotal))}</span>
        </div>
        <div class="order-line-qty" aria-label="${esc(dish.name)}">
          <button type="button" class="order-qty-btn" data-action="cart-dec" data-menu="${esc(menu)}" data-dish="${esc(dish.id)}" aria-label="−">−</button>
          <span class="order-qty-val">${entry.qty}</span>
          <button type="button" class="order-qty-btn" data-action="cart-inc" data-menu="${esc(menu)}" data-dish="${esc(dish.id)}" aria-label="+">+</button>
        </div>
      </li>
    `;
  }).join("");
  const total = cartSubtotal(menu);
  const empty = items.length === 0;

  return `
    <div class="screen">
      <article class="sheet sheet-pad order-sheet" data-accent="${menu}">
        <a class="back" data-nav href="${esc(appHref(menu))}">
          <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M10 3 L5 8 L10 13" fill="none" stroke="currentColor" stroke-width="1.6"></path></svg>
          ${esc(copy.back)}
        </a>
        <p class="eyebrow">MESA ${esc(tableLabel())}</p>
        <h1 class="dish-title">${esc(copy.orderTitle)}</h1>
        ${empty
    ? `<p class="desc order-empty">${esc(copy.orderEmpty)}</p>`
    : `
          <ul class="order-list">${lines}</ul>
          <div class="order-footer">
            <p class="order-total-row">
              <span>${esc(copy.orderTotal)}</span>
              <strong>${esc(price(menu, total))}</strong>
            </p>
            <button class="order-btn order-btn-place" type="button" data-action="place-order" data-menu="${esc(menu)}">${esc(copy.placeOrder)}</button>
          </div>
        `}
      </article>
    </div>
  `;
}

function pedidoPlacedView(menu) {
  const copy = copyOf(menu);
  return `
    <div class="screen">
      <article class="sheet sheet-pad order-sheet" data-accent="${menu}">
        <a class="back" data-nav href="${esc(appHref(menu))}">
          <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M10 3 L5 8 L10 13" fill="none" stroke="currentColor" stroke-width="1.6"></path></svg>
          ${esc(copy.back)}
        </a>
        <h1 class="dish-title">${esc(copy.orderPlacedTitle)}</h1>
        <p class="desc">${esc(copy.orderPlacedBody)}</p>
      </article>
    </div>
  `;
}

function shellMarkup(menu) {
  const copy = copyOf(menu);
  return `
    <section class="viewer" data-accent="${menu}">
      <canvas class="viewer-canvas" aria-hidden="true"></canvas>
      <div class="viewer-overlay">
      <div class="xr-hud" hidden>
      <button class="viewer-back" type="button" data-action="show-menu">
        <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M10 3 L5 8 L10 13" fill="none" stroke="currentColor" stroke-width="1.6"></path></svg>
        ${esc(copy.back)}
      </button>
      <button class="viewer-order" type="button" data-action="view-order" data-menu="${esc(menu)}">
        <span>${esc(copy.viewOrder)}</span>
        ${cartItemCount(menu) ? `<span class="viewer-order-badge" aria-hidden="true">${cartItemCount(menu)}</span>` : ""}
      </button>
      <p class="viewer-hint">${esc(copy.scanReady)}</p>
      <p class="viewer-alert" hidden></p>
      <div class="viewer-card" hidden>
        <div class="viewer-heading">
          <h1></h1>
          <p class="price-lg"></p>
          <button class="viewer-remove" type="button" data-action="remove-dish" aria-label="${esc(copy.removeDish)}">
            <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M6 2.5 H10 M3.5 4.5 H12.5 M5 4.5 V13 Q5 14 6 14 H10 Q11 14 11 13 V4.5 M7 6.5 V12 M9 6.5 V12" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"></path></svg>
          </button>
          <button class="viewer-add" type="button" data-action="add-dish" data-menu="${esc(menu)}" data-dish="" aria-label="${esc(copy.add)}">
            <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M8 2.5 V13.5 M2.5 8 H13.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"></path></svg>
            <span class="viewer-add-label">${esc(copy.add)}</span>
            <span class="viewer-add-count" hidden></span>
          </button>
        </div>
        <div class="viewer-facts">
          <div class="viewer-facts-scroller" data-facts-scroller>
            <div class="viewer-facts-track"></div>
          </div>
          <button class="viewer-facts-next" type="button" data-facts-next data-next-label="${esc(copy.factsNext)}" data-back-label="${esc(copy.factsBack)}" aria-label="${esc(copy.factsNext)}" hidden>
            <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M6 3 L11 8 L6 13" fill="none" stroke="currentColor" stroke-width="1.6"></path></svg>
          </button>
        </div>
      </div>
      </div>
      <div class="xr-menu"></div>
      <div class="pick-dock" hidden>
        <p class="pick-dock-label">${esc(copy.selectMode)}</p>
        <div class="pick-dock-actions">
          <button class="place-cancel" type="button" data-action="cancel-pick">${esc(copy.cancelSelect)}</button>
          <button class="ar-btn" type="button" data-action="place-queue" data-menu="${esc(menu)}">${esc(copy.placeQueue)}</button>
        </div>
      </div>
      </div>
    </section>
  `;
}

function missing(menu) {
  const copy = copyOf(menu);
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

function dishInfoView(menu, section, dish) {
  const copy = copyOf(menu);
  const qty = cartQty(menu, dish.id);
  return `
    <div class="screen">
      <article class="sheet sheet-pad" data-accent="${menu}">
        <button class="back" type="button" data-action="show-menu">
          <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M10 3 L5 8 L10 13" fill="none" stroke="currentColor" stroke-width="1.6"></path></svg>
          ${esc(copy.back)}
        </button>
        <p class="eyebrow">${esc(section.title)}</p>
        <h1 class="dish-title">${esc(dish.name)}</h1>
        <p class="price-lg">${esc(price(menu, dish.price))}</p>
        <p class="portion">${esc(dish.portion)}</p>
        <p class="desc">${esc(dish.description || dish.blurb)}</p>
        <dl class="nutrition">${copy.nutrients.map((item) => `
          <div>
            <dt>${esc(item.label)}</dt>
            <dd>${esc(dish.nutrition[item.key])} ${esc(item.unit)}</dd>
          </div>
        `).join("")}</dl>
        <p class="desc">${esc(copy.allergensTitle)}: ${dish.allergens.length ? esc(dish.allergens.join(", ")) : esc(copy.noAllergens)}</p>
        <div class="menu-actions">
          <button class="order-btn order-btn-place${qty ? " is-added" : ""}" type="button" data-action="add-dish" data-menu="${esc(menu)}" data-dish="${esc(dish.id)}" aria-label="${esc(qty ? addedLabel(copy, qty) : copy.add)}">
            <span class="viewer-add-label">${esc(copy.add)}</span>
            <span class="viewer-add-count"${qty ? "" : " hidden"}>${qty || ""}</span>
          </button>
        </div>
      </article>
    </div>
  `;
}

function showDishInfo(menu, dishId) {
  const found = findDish(menu, dishId);
  const menuSlot = app.querySelector(".xr-menu");
  if (!found || !menuSlot) return;
  menuSlot.innerHTML = dishInfoView(menu, textSection(menu, found.section), textDish(menu, found.dish));
  menuSlot.scrollTop = 0;
}

function arErrorMessage(error, copy) {
  if (!window.isSecureContext) return copy.arInsecure;
  const name = error && error.name;
  if (name === "NotAllowedError" || name === "SecurityError") return copy.arDenied;
  return copy.arFailed;
}

function cancelSource(source) {
  if (!source) return;
  try {
    source.cancel();
  } catch {
    /* La fuente de hit test ya estaba cancelada. */
  }
}

function releaseWorld(view) {
  for (const pin of world.pinned) {
    if (pin.slot) pin.slot.cancelled = true;
    pin.slot?.anchor?.delete?.();
    if (pin.slot) pin.slot.anchor = null;
    view?.scene?.remove(pin.group);
  }
  world.pinned = [];
  world.menu = null;
}

function disposeView(view) {
  view.renderer?.setAnimationLoop(null);
  cancelAnimationFrame(view.frame);
  cancelSource(view.hitTestSource);
  view.hitTestSource = null;
  view.overlay?.removeEventListener("pointerdown", view.onPlacePointer);
  if (view.overlay) view.overlay.style.pointerEvents = "";
  view.occluder?.geometry.dispose();
  view.occluder?.material.dispose();
  view.depthQuad?.userData.depthTexture2D?.dispose();
  view.depthQuad?.userData.depthTextureArray?.dispose();
  view.depthQuad?.geometry.dispose();
  view.depthQuad?.material.dispose();
  view.selectRing?.geometry.dispose();
  view.selectRing?.material.dispose();
  view.observer?.disconnect();
  view.factsObserver?.disconnect();
  window.removeEventListener("pointerup", view.onUp);
  window.clearTimeout(view.alertTimer);
  view.renderer?.dispose();
}

function stopViewer() {
  generation += 1;
  const current = active;
  active = null;
  if (!current) return;
  current.renderer?.setAnimationLoop(null);
  cancelAnimationFrame(current.frame);
  cancelSource(current.hitTestSource);
  current.hitTestSource = null;
  releaseWorld(current);
  if (current.anchorSlot) current.anchorSlot.cancelled = true;
  current.anchor?.delete?.();
  current.anchor = null;
  current.anchorSlot = null;
  current.overlay?.removeEventListener("pointerdown", current.onPlacePointer);
  if (current.overlay) current.overlay.style.pointerEvents = "";
  current.occluder?.geometry.dispose();
  current.occluder?.material.dispose();
  const session = current.session;
  current.session = null;
  session?.end().catch(() => {});
  current.observer?.disconnect();
  current.factsObserver?.disconnect();
  window.removeEventListener("pointerup", current.onUp);
  window.clearTimeout(current.alertTimer);
  current.renderer?.dispose();
}

function showViewerAlert(text) {
  const alert = app.querySelector(".viewer-alert");
  if (!alert) return;
  alert.hidden = false;
  alert.textContent = text;
  window.clearTimeout(active?.alertTimer);
  if (!active) return;
  active.alertTimer = window.setTimeout(() => {
    alert.hidden = true;
  }, 2600);
}

function setViewerHint(text) {
  const hint = app.querySelector(".viewer-hint");
  if (hint) hint.textContent = text;
}

function syncArButton() {
  const live = Boolean(active?.session);
  app.querySelectorAll("[data-action='start-ar']").forEach((btn) => {
    btn.hidden = active?.arReady === false || live;
  });
}

function viewerEl() {
  return app.querySelector(".viewer");
}

function showMenuLayer() {
  const viewer = viewerEl();
  const hud = app.querySelector(".xr-hud");
  const card = app.querySelector(".viewer-card");
  viewer?.classList.remove("is-placing", "is-detail", "is-world");
  if (card) card.hidden = true;
  active?.selectRing?.removeFromParent();
  if (active) active.selectedGroup = null;
  if (active?.session) {
    viewer?.classList.add("is-live");
    if (hud) hud.hidden = true;
    active.suspendPlace = true;
    if (active.reticle) active.reticle.visible = false;
  } else {
    viewer?.classList.remove("is-live");
    if (hud) hud.hidden = true;
  }
  syncArButton();
}

function showPlacingLayer() {
  const viewer = viewerEl();
  const hud = app.querySelector(".xr-hud");
  const card = app.querySelector(".viewer-card");
  viewer?.classList.add("is-live", "is-placing");
  viewer?.classList.remove("is-detail", "is-world");
  if (hud) hud.hidden = false;
  if (card) card.hidden = true;
  active?.selectRing?.removeFromParent();
  if (active) {
    active.selectedGroup = null;
    active.suspendPlace = false;
  }
}

function showWorldLayer() {
  const viewer = viewerEl();
  const hud = app.querySelector(".xr-hud");
  const card = app.querySelector(".viewer-card");
  viewer?.classList.add("is-live", "is-world");
  viewer?.classList.remove("is-placing", "is-detail");
  if (hud) hud.hidden = false;
  if (card) card.hidden = true;
  active?.selectRing?.removeFromParent();
  if (active) {
    active.selectedGroup = null;
    active.suspendPlace = true;
    active.liveReady = false;
    if (active.reticle) active.reticle.visible = false;
    setViewerHint(copyOf(active.menu).selectHint);
  }
}

function showDetailLayer() {
  const viewer = viewerEl();
  const hud = app.querySelector(".xr-hud");
  const card = app.querySelector(".viewer-card");
  viewer?.classList.add("is-live", "is-detail");
  viewer?.classList.remove("is-placing", "is-world");
  if (hud) hud.hidden = false;
  if (card) card.hidden = false;
  if (active) active.suspendPlace = true;
}

function paintShell(menu, state) {
  const menuSlot = app.querySelector(".xr-menu");
  if (!menuSlot) return;
  const placing = viewerEl()?.classList.contains("is-placing")
    || viewerEl()?.classList.contains("is-world")
    || viewerEl()?.classList.contains("is-detail");

  if (state?.pedido) {
    if (active?.session) retireUnpinnedLive(active);
    showMenuLayer();
    menuSlot.innerHTML = pedidoView(menu);
    menuSlot.scrollTop = 0;
    return;
  }

  if (state?.missing) {
    showMenuLayer();
    menuSlot.innerHTML = missing(menu);
    menuSlot.scrollTop = 0;
    return;
  }

  menuSlot.innerHTML = carta(menu);
  if (!placing) {
    showMenuLayer();
    menuSlot.scrollTop = 0;
  }
  syncArButton();
  applyPickState(menu);
}

function togglePicked(id) {
  const i = pickedIds.indexOf(id);
  if (i >= 0) pickedIds.splice(i, 1);
  else pickedIds.push(id);
  if (!pickedIds.length) pickMode = false;
}

function applyPickState(menu) {
  const copy = copyOf(menu);
  app.querySelectorAll("[data-pick-dish]").forEach((btn) => {
    btn.classList.toggle("is-picked", pickedIds.includes(btn.dataset.dish));
  });
  app.querySelector(".menu-card")?.classList.toggle("is-picking", pickMode);
  app.querySelector(".menu-actions")?.toggleAttribute("hidden", pickMode);
  const dock = app.querySelector(".pick-dock");
  if (!dock) return;
  dock.hidden = !pickMode;
  const label = dock.querySelector(".pick-dock-label");
  if (label) label.textContent = copy.selectMode;
  const placeBtn = dock.querySelector("[data-action='place-queue']");
  if (placeBtn) {
    placeBtn.dataset.menu = menu;
    placeBtn.disabled = pickedIds.length < 1;
    placeBtn.textContent = placeQueueLabel(copy);
  }
}

function prefetchQueueModels() {
  prefetchDishModels(placeQueue.map((item) => item.id));
}

function queueScanHint(menu, dishId) {
  const copy = copyOf(menu);
  const rest = placeQueue.slice(1);
  const loading = isDishModelReady(dishId) ? copy.scanHint : copy.modelLoading;
  if (!rest.length) return loading;
  const found = findDish(rest[0].menu, rest[0].id);
  const name = found ? textDish(rest[0].menu, found.dish).name : "";
  return `${loading} ${copy.nextInQueue.replace("{name}", name)}`;
}

function startPlacement() {
  const view = active;
  if (!view || !placeQueue.length) return;
  prefetchQueueModels();
  queryAR().then((supported) => {
    if (active !== view || !placeQueue.length) return;
    view.arReady = supported;
    syncArButton();
    if (!supported) {
      showToast(copyOf(view.menu).arUnsupported);
      placeQueue.length = 0;
      return;
    }
    if (view.session) beginQueuePlacement();
    else beginScan();
  });
}

function beginQueuePlacement() {
  const view = active;
  const next = placeQueue[0];
  if (!view?.session || !next) {
    if (view?.session) showWorldLayer();
    else showMenuLayer();
    return;
  }
  prefetchQueueModels();
  showPlacingLayer();
  view.queueItem = next;
  if (view.liveDishId === next.id && view.model && view.placed && !view.placed.userData.pin) {
    view.suspendPlace = false;
    view.liveReady = true;
    setViewerHint(queueScanHint(next.menu, next.id));
    return;
  }
  mountLiveDish(view, next.menu, next.id);
}

function mountShell(menu) {
  const token = generation;
  const canvas = app.querySelector(".viewer-canvas");
  if (!canvas) return;

  const view = setupThree(canvas, token);
  view.menu = menu;
  view.uiLang = menuLang(menu);
  view.liveToken = 0;
  active = view;
  world.menu = menu;
  bindFactsScroller();
  view.start();

  queryAR().then((supported) => {
    if (generation !== token || active !== view) return;
    view.arReady = supported;
    syncArButton();
    if (placeQueue.length && supported) startPlacement();
  });
}

function isHorizontalSurface(matrix) {
  return matrix[5] > 0.75;
}

function guardDepthBinding() {
  if (typeof XRWebGLBinding === "undefined") return;
  const proto = XRWebGLBinding.prototype;
  if (proto.__mesaDepthGuard || typeof proto.getDepthInformation !== "function") return;
  const original = proto.getDepthInformation;
  proto.getDepthInformation = function guardedDepthInformation(view) {
    try {
      return original.call(this, view);
    } catch {
      return null;
    }
  };
  proto.__mesaDepthGuard = true;
}

function useLayerDepthBuffer() {
  if (typeof XRProjectionLayer === "undefined") return;
  const proto = XRProjectionLayer.prototype;
  if (proto.__mesaUseDepth) return;
  try {
    Object.defineProperty(proto, "ignoreDepthValues", { configurable: true, get: () => true });
    proto.__mesaUseDepth = true;
  } catch {
    /* El navegador no deja cambiar el flag. */
  }
}

function hideDepthFromRenderer(session) {
  const features = session.enabledFeatures;
  if (!features?.includes("depth-sensing")) return;
  const visible = features.filter((feature) => feature !== "depth-sensing");
  try {
    Object.defineProperty(session, "enabledFeatures", { get: () => visible });
  } catch {
    /* El navegador no deja ocultar la función; el guard de WebGL cubre la llamada. */
  }
}

function createDepthQuad() {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array([
    -1, -1, 0,
    3, -1, 0,
    -1, 3, 0,
  ]), 3));
  const depthTexture2D = new THREE.DataTexture(
    new Float32Array([0]),
    1,
    1,
    THREE.RedFormat,
    THREE.FloatType
  );
  depthTexture2D.generateMipmaps = false;
  depthTexture2D.flipY = false;
  depthTexture2D.magFilter = THREE.NearestFilter;
  depthTexture2D.minFilter = THREE.NearestFilter;
  depthTexture2D.wrapS = THREE.ClampToEdgeWrapping;
  depthTexture2D.wrapT = THREE.ClampToEdgeWrapping;
  if (THREE.NoColorSpace) depthTexture2D.colorSpace = THREE.NoColorSpace;
  depthTexture2D.needsUpdate = true;
  const depthTextureArray = new THREE.DataArrayTexture(new Float32Array([0]), 1, 1, 1);
  depthTextureArray.generateMipmaps = false;
  depthTextureArray.flipY = false;
  depthTextureArray.magFilter = THREE.NearestFilter;
  depthTextureArray.minFilter = THREE.NearestFilter;
  depthTextureArray.wrapS = THREE.ClampToEdgeWrapping;
  depthTextureArray.wrapT = THREE.ClampToEdgeWrapping;
  if (THREE.NoColorSpace) depthTextureArray.colorSpace = THREE.NoColorSpace;
  depthTextureArray.needsUpdate = true;
  const material = new THREE.ShaderMaterial({
    uniforms: {
      uDepth2D: { value: depthTexture2D },
      uMetersInRed: { value: 1 },
      uRawToMeters: { value: 1 },
      uPack: { value: 0 },
      uViewToDepth: { value: new THREE.Matrix4() },
      uViewport: { value: new THREE.Vector4(0, 0, 1, 1) },
      uProjZ: { value: new THREE.Vector4(0, 0, -1, 0) },
      uBias: { value: OCCLUSION_BIAS_M },
      uDepthArray: { value: depthTextureArray },
      uUseArray: { value: 0 },
      uLayer: { value: 0 },
    },
    glslVersion: THREE.GLSL3,
    vertexShader: `
      in vec3 position;
      void main() {
        gl_Position = vec4(position.xy, 0.0, 1.0);
      }
    `,
    fragmentShader: `
      precision highp float;
      uniform sampler2D uDepth2D;
      uniform sampler2DArray uDepthArray;
      uniform int uUseArray;
      uniform float uLayer;
      uniform int uMetersInRed;
      uniform float uRawToMeters;
      uniform float uPack;
      uniform mat4 uViewToDepth;
      uniform vec4 uViewport;
      uniform vec4 uProjZ;
      uniform float uBias;
      out vec4 fragColor;
      void main() {
        vec2 normView = vec2(
          (gl_FragCoord.x - uViewport.x) / max(uViewport.z, 1.0),
          1.0 - (gl_FragCoord.y - uViewport.y) / max(uViewport.w, 1.0)
        );
        vec2 depthUv = (uViewToDepth * vec4(normView, 0.0, 1.0)).xy;
        if (depthUv.x < 0.0 || depthUv.y < 0.0 || depthUv.x > 1.0 || depthUv.y > 1.0) discard;
        vec4 packed = uUseArray == 1
          ? texture(uDepthArray, vec3(depthUv, uLayer))
          : texture(uDepth2D, depthUv);
        float meters = uMetersInRed == 1
          ? packed.r
          : (uPack > 0.5 ? dot(packed.ra, vec2(65280.0, 255.0)) : packed.r) * uRawToMeters;
        if (meters <= 0.04 || meters > 8.0) discard;
        meters = max(meters - uBias, 0.04);
        float viewZ = -meters;
        float clipZ = uProjZ.x * viewZ + uProjZ.y;
        float clipW = uProjZ.z * viewZ + uProjZ.w;
        if (clipW <= 0.0001) discard;
        fragColor = vec4(0.0);
        gl_FragDepth = clamp((clipZ / clipW) * 0.5 + 0.5, 0.0, 1.0);
      }
    `,
    depthTest: true,
    depthWrite: true,
    depthFunc: THREE.AlwaysDepth,
    colorWrite: false,
    toneMapped: false,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  mesh.renderOrder = -1e6;
  mesh.visible = false;
  mesh.name = "depthQuad";
  mesh.userData.depthTexture2D = depthTexture2D;
  mesh.userData.depthTextureArray = depthTextureArray;
  return mesh;
}

function isHudEvent(event) {
  return Boolean(event.target.closest("button, a, input, select, label, .viewer-card, .xr-menu, .place-bar, .menu-card, .pick-dock"));
}

function occlusionUniforms(view) {
  if (view.occlusionShared) return view.occlusionShared;
  const tex = view.depthQuad?.userData.depthTexture2D;
  view.occlusionShared = {
    uOcclusionDepth: { value: tex },
    uOcclusionActive: { value: 0 },
    uOcclusionMetersInRed: { value: 1 },
    uOcclusionRawToMeters: { value: 1 },
    uOcclusionPack: { value: 0 },
    uOcclusionViewToDepth: { value: new THREE.Matrix4() },
    uOcclusionViewport: { value: new THREE.Vector4(0, 0, 1, 1) },
    uOcclusionBias: { value: OCCLUSION_BIAS_M },
  };
  return view.occlusionShared;
}

function setOcclusionActive(view, on) {
  const u = occlusionUniforms(view);
  u.uOcclusionActive.value = on ? 1 : 0;
}

function patchOcclusionMaterial(material) {
  if (!material || material.userData.mesaOcclusion) return;
  material.userData.mesaOcclusion = true;
  const previous = material.onBeforeCompile;
  const previousKey = material.customProgramCacheKey?.bind(material);
  material.onBeforeCompile = (shader, renderer) => {
    previous?.(shader, renderer);
    const view = active;
    if (view) Object.assign(shader.uniforms, occlusionUniforms(view));
    const canInject =
      shader.vertexShader.includes("#include <project_vertex>") &&
      shader.fragmentShader.includes("#include <dithering_fragment>");
    if (!canInject) return;
    if (!shader.vertexShader.includes("vOcclusionDepth")) {
      shader.vertexShader = shader.vertexShader.replace(
        "#include <common>",
        `#include <common>\n${OCCLUSION_VERT_DECL}`
      );
      shader.vertexShader = shader.vertexShader.replace(
        "#include <project_vertex>",
        `#include <project_vertex>\n${OCCLUSION_VERT_SET}`
      );
    }
    if (!shader.fragmentShader.includes("uOcclusionActive")) {
      shader.fragmentShader = shader.fragmentShader.replace(
        "#include <common>",
        `#include <common>\n${OCCLUSION_FRAG_DECL}`
      );
      shader.fragmentShader = shader.fragmentShader.replace(
        "#include <dithering_fragment>",
        `#include <dithering_fragment>\n${OCCLUSION_FRAG_BODY}`
      );
    }
  };
  material.customProgramCacheKey = () =>
    `${previousKey ? previousKey() : ""}|mesa-occlusion-v3`;
  material.needsUpdate = true;
}

function keepDishDepth(root) {
  root?.traverse((node) => {
    const list = Array.isArray(node.material) ? node.material : node.material ? [node.material] : [];
    for (const mat of list) {
      if (!mat) continue;
      if (mat.userData.mesaOcclusion) {
        mat.onBeforeCompile = mat.userData.mesaOcclusionPrev || null;
        mat.customProgramCacheKey = mat.userData.mesaOcclusionPrevKey || undefined;
        mat.userData.mesaOcclusion = false;
        mat.needsUpdate = true;
      }
    }
  });
}

function setDishScale(view, scale) {
  if (!view.model || !view.shadow) return;
  keepDishDepth(view.model);
  view.model.scale.setScalar(scale);
  const shadowScale = scale / DISH_SCALE_SHADOW_REF;
  view.shadow.scale.set(shadowScale, shadowScale, shadowScale);
}

function applyViewerLighting(view, studio) {
  const preset = studio ? VIEWER_LIGHT_STUDIO : VIEWER_LIGHT_AR;
  const { hemi, key, fill, rim, ambient, bounce } = view.lights;
  if (!hemi) return;
  hemi.intensity = preset.hemi;
  hemi.color.setHex(studio ? 0xffffff : 0xfff6ea);
  hemi.groundColor.setHex(studio ? 0xb8aea4 : 0x2a211c);
  key.intensity = preset.key;
  fill.intensity = preset.fill;
  if (rim) {
    rim.intensity = preset.rim;
    rim.visible = preset.rim > 0;
  }
  if (ambient) {
    ambient.intensity = preset.ambient;
    ambient.visible = preset.ambient > 0;
  }
  if (bounce) {
    bounce.intensity = studio ? 1.8 : 0;
    bounce.visible = studio;
  }
  view.renderer.toneMappingExposure = preset.exposure;
}

function showStudio(view) {
  if (!view.placed || !view.model) return;
  view.studio = true;
  view.surfaceSeen = false;
  view.surfaceValid = false;
  view.dishPlaced = false;
  view.placing = false;
  view.placeRequested = false;
  view.blockedSurface = false;
  view.blockedOverlap = false;
  view.overlapSeen = false;
  view.liveReady = false;
  view.liveDishId = null;
  view.suspendPlace = false;
  view.anchor?.delete?.();
  view.anchor = null;
  view.anchorSlot = null;
  view.selectRing?.removeFromParent();
  if (view.overlay) view.overlay.style.pointerEvents = "";
  const pinBtn = app.querySelector(".viewer-pin");
  if (pinBtn) pinBtn.hidden = true;
  view.placed.matrixAutoUpdate = true;
  view.placed.position.set(0, 0, 0);
  view.placed.rotation.set(0, 0, 0);
  view.placed.scale.set(1, 1, 1);
  view.placed.visible = true;
  setDishScale(view, DISH_SCALE_PREVIEW);
  view.reticle.visible = false;
  view.reticle.material.color.setHex(RETICLE_SCAN);
  if (view.occluder) view.occluder.visible = false;
  if (view.depthQuad) view.depthQuad.visible = false;
  view.gpuDepth = null;
  view.depthBinding = undefined;
  if (view.gpuOccluder) {
    view.scene.remove(view.gpuOccluder);
    view.gpuOccluder = null;
  }
  view.camera.position.set(0.15, 2.15, 6.4);
  view.camera.lookAt(0, 0.18, 0);
  applyViewerLighting(view, true);
  view.resize();
}

function applyLockedMatrix(view, matrix) {
  _eyeWorld.fromArray(matrix);
  _eyeWorld.decompose(_hitPos, _hitQuat, _hitScale);
  _hitEuler.setFromQuaternion(_hitQuat, "YXZ");
  view.lockedYaw = _hitEuler.y;
  view.placed.matrixAutoUpdate = true;
  view.placed.position.copy(_hitPos);
  view.placed.rotation.set(0, view.lockedYaw, 0);
  view.placed.scale.set(1, 1, 1);
  view.placed.updateMatrix();
}

function showSearchReticle(view) {
  const xrCam = view.renderer.xr.getCamera();
  xrCam.updateMatrixWorld(true);
  _searchPos.set(0, 0, -0.55).applyMatrix4(xrCam.matrixWorld);
  _searchQuat.setFromRotationMatrix(xrCam.matrixWorld);
  view.reticle.matrixAutoUpdate = true;
  view.reticle.position.copy(_searchPos);
  view.reticle.quaternion.copy(_searchQuat);
  view.reticle.rotateX(Math.PI / 2);
  view.reticle.scale.set(1, 1, 1);
  view.reticle.visible = true;
  view.reticle.material.color.setHex(RETICLE_SCAN);
  view.surfaceValid = false;
}

function placeReticle(view, matrix, valid) {
  _eyeWorld.fromArray(matrix);
  _eyeWorld.decompose(view.reticle.position, view.reticle.quaternion, _hitScale);
  view.reticle.matrixAutoUpdate = true;
  view.reticle.scale.set(1, 1, 1);
  if (valid) view.reticle.position.y += 0.004;
  view.reticle.visible = true;
  view.reticle.material.color.setHex(valid ? RETICLE_READY : RETICLE_SCAN);
  view.surfaceValid = valid;
}

function worldFootprint(group) {
  if (!group) return 0.22;
  const ring = group.children.find((child) => child.name === "selectRing");
  if (ring) group.remove(ring);
  _box.setFromObject(group);
  if (ring) group.add(ring);
  if (_box.isEmpty()) return 0.22;
  _box.getSize(_boxSize);
  return Math.max(_boxSize.x, _boxSize.z, 0.12) / 2;
}

function footprintAtARScale(view) {
  if (!view.model) return 0.22;
  const scale = view.model.scale.x || 1;
  _box.setFromObject(view.model);
  if (_box.isEmpty()) return 0.22;
  _box.getSize(_boxSize);
  const factor = DISH_SCALE_AR / scale;
  return Math.max(_boxSize.x, _boxSize.z, 0.08) * factor / 2;
}

function liveRadiusOf(view) {
  return view.liveRadius > 0 ? view.liveRadius : 0.22;
}

function overlapsPins(point, radius) {
  for (const pin of world.pinned) {
    pin.group.getWorldPosition(_pinPos);
    const dx = _pinPos.x - point.x;
    const dz = _pinPos.z - point.z;
    const limit = pin.radius + radius + 0.012;
    if (dx * dx + dz * dz < limit * limit) return true;
  }
  return false;
}

function placementHint(view, copy) {
  return world.pinned.length > 0 ? copy.readyToPinMore : copy.readyToPin;
}

function factsHtml(menu, section, dish) {
  const copy = copyOf(menu);
  const nutrients = copy.nutrients.map((item) => `
    <div>
      <dt>${esc(item.label)}</dt>
      <dd>${esc(dish.nutrition[item.key])} ${esc(item.unit)}</dd>
    </div>
  `).join("");
  return `
    <p class="portion">${esc(dish.portion)} · ${esc(section.title)}</p>
    <dl class="nutrition">${nutrients}</dl>
    <p class="viewer-allergens">${esc(copy.allergensTitle)}: ${dish.allergens.length ? esc(dish.allergens.join(", ")) : esc(copy.noAllergens)}</p>
  `;
}

function fillViewerCard(menu, section, dish) {
  const card = app.querySelector(".viewer-card");
  if (!card) return;
  const copy = copyOf(menu);
  const title = card.querySelector("h1");
  const priceEl = card.querySelector(".price-lg");
  const track = card.querySelector(".viewer-facts-track");
  const scroller = card.querySelector("[data-facts-scroller]");
  const canvas = app.querySelector(".viewer-canvas");
  if (title) title.textContent = dish.name;
  if (priceEl) priceEl.textContent = price(menu, dish.price);
  if (track) track.innerHTML = factsHtml(menu, section, dish);
  if (scroller) scroller.scrollLeft = 0;
  if (canvas) canvas.setAttribute("aria-label", dish.name);
  const add = card.querySelector("[data-action='add-dish']");
  if (add) {
    add.dataset.menu = menu;
    add.dataset.dish = dish.id;
    paintAddButton(add, cartQty(menu, dish.id));
  }
  const remove = card.querySelector("[data-action='remove-dish']");
  if (remove) remove.setAttribute("aria-label", copy.removeDish);
  card.hidden = false;
  active?.syncFacts?.();
}

function ensureSelectRing(view) {
  if (view.selectRing) return view.selectRing;
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.12, 0.15, 48),
    new THREE.MeshBasicMaterial({ color: 0xf0c27a, side: THREE.DoubleSide, depthWrite: false })
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.012;
  ring.name = "selectRing";
  ring.renderOrder = 2;
  view.selectRing = ring;
  return ring;
}

function selectGroup(view, group, hint) {
  if (!group) return;
  const pin = group.userData.pin;
  const menu = pin?.menu || group.userData.menu || view.menu;
  const dishId = pin?.dishId || group.userData.dishId || view.dishId;
  const found = findDish(menu, dishId);
  if (!found) return;
  view.selectedGroup = group;
  fillViewerCard(menu, textSection(menu, found.section), textDish(menu, found.dish));
  showDetailLayer();
  const several = placedGroups(view).length > 1;
  if (several) {
    const ring = ensureSelectRing(view);
    ring.removeFromParent();
    const radius = pin?.radius || view.liveRadius || 0.22;
    ring.scale.setScalar((Math.max(radius, 0.05) * 1.12) / 0.15);
    group.add(ring);
  } else {
    view.selectRing?.removeFromParent();
  }
  if (hint) setViewerHint(hint);
  else setViewerHint(copyOf(menu).selectHint);
}

function placedGroups(view) {
  const groups = [];
  for (const pin of world.pinned) {
    if (pin.group.visible) groups.push(pin.group);
  }
  if (view.dishPlaced && view.placed?.visible) groups.push(view.placed);
  return groups;
}

function groupOf(object, groups) {
  let node = object;
  while (node) {
    if (groups.includes(node)) return node;
    node = node.parent;
  }
  return null;
}

function xrCamera(view) {
  const cam = view.renderer.xr.getCamera();
  return cam.cameras?.[0] || cam;
}

function selectFromHits(view, hits, groups) {
  if (!hits.length) return false;
  const group = groupOf(hits[0].object, groups);
  if (!group) return false;
  selectGroup(view, group);
  return true;
}

function selectDishAtPointer(view, event) {
  if (!view.session) return false;
  const groups = placedGroups(view);
  if (!groups.length) return false;
  const width = window.innerWidth || 1;
  const height = window.innerHeight || 1;
  _ndc.set((event.clientX / width) * 2 - 1, -(event.clientY / height) * 2 + 1);
  const cam = xrCamera(view);
  _raycaster.setFromCamera(_ndc, cam);
  if (selectFromHits(view, _raycaster.intersectObjects(groups, true), groups)) return true;
  let best = null;
  let bestDist = 0.16;
  for (const group of groups) {
    group.getWorldPosition(_pinPos);
    _pinPos.project(cam);
    if (_pinPos.z < -1 || _pinPos.z > 1) continue;
    const dist = Math.hypot(_pinPos.x - _ndc.x, _pinPos.y - _ndc.y);
    if (dist < bestDist) {
      bestDist = dist;
      best = group;
    }
  }
  if (!best) return false;
  selectGroup(view, best);
  return true;
}

function selectAlongXR(view, event) {
  if (!view.session) return false;
  const space = event.inputSource?.targetRaySpace;
  const frame = event.frame;
  const referenceSpace = view.renderer.xr.getReferenceSpace();
  if (!space || !frame || !referenceSpace) return false;
  const pose = frame.getPose(space, referenceSpace);
  if (!pose) return false;
  _rayMatrix.fromArray(pose.transform.matrix);
  _rayOrigin.setFromMatrixPosition(_rayMatrix);
  _rayDir.set(0, 0, -1).transformDirection(_rayMatrix);
  _raycaster.set(_rayOrigin, _rayDir);
  _raycaster.far = 20;
  const groups = placedGroups(view);
  if (!groups.length) return false;
  return selectFromHits(view, _raycaster.intersectObjects(groups, true), groups);
}

function pinLiveDish(view, { silent = false } = {}) {
  if (!view?.session) return false;
  const copy = copyOf(view.menu);
  if (!view.dishPlaced || !view.placed || !view.model) {
    if (!silent) showViewerAlert(copy.pinNeedPlace);
    return false;
  }
  const group = view.placed;
  const slot = view.anchorSlot || { anchor: view.anchor, cancelled: false };
  const pin = {
    menu: view.menu,
    dishId: view.dishId,
    group,
    slot,
    radius: Math.max(worldFootprint(group), 0.05),
  };
  group.userData.pin = pin;
  group.userData.menu = view.menu;
  group.userData.dishId = view.dishId;
  world.pinned.push(pin);
  world.menu = view.menu;
  view.anchorSlot = null;
  view.anchor = null;
  view.dishPlaced = false;
  view.placing = false;
  view.placeRequested = false;
  view.liveReady = false;
  view.liveDishId = null;
  view.liveToken = (view.liveToken || 0) + 1;
  view.placed = null;
  view.model = null;
  view.shadow = null;
  view.reticle.visible = false;
  if (!silent) showToast(copy.pinnedToast);
  return true;
}

function commitPlacedDish(view) {
  const item = view.queueItem;
  if (!pinLiveDish(view, { silent: true })) return;
  if (item) dequeueToken(item.token);
  view.queueItem = null;
  showToast(copyOf(view.menu).pinnedToast);
  if (placeQueue.length) beginQueuePlacement();
  else showWorldLayer();
}

function removeSelectedDish() {
  const view = active;
  const group = view?.selectedGroup;
  if (!view || !group) return;
  const pin = group.userData.pin;
  if (pin) {
    world.pinned = world.pinned.filter((item) => item !== pin);
    if (pin.slot) pin.slot.cancelled = true;
    pin.slot?.anchor?.delete?.();
  }
  if (group === view.placed) retireUnpinnedLive(view);
  view.selectRing?.removeFromParent();
  view.selectedGroup = null;
  view.scene.remove(group);
  const card = app.querySelector(".viewer-card");
  if (card) card.hidden = true;
  if (view.session) showWorldLayer();
  else showMenuLayer();
}

function retireUnpinnedLive(view) {
  if (!view) return;
  view.liveToken = (view.liveToken || 0) + 1;
  view.liveReady = false;
  view.liveDishId = null;
  view.dishPlaced = false;
  view.placing = false;
  view.placeRequested = false;
  const group = view.placed;
  if (view.anchorSlot) view.anchorSlot.cancelled = true;
  view.anchor?.delete?.();
  view.anchor = null;
  view.anchorSlot = null;
  if (group?.userData.pin) {
    view.placed = null;
    view.model = null;
    view.shadow = null;
    return;
  }
  if (group) view.scene.remove(group);
  view.placed = null;
  view.model = null;
  view.shadow = null;
}

function skipFailedDish(view, menu) {
  showViewerAlert(copyOf(menu).modelFailed);
  showToast(copyOf(menu).modelFailed);
  dequeueCurrent(view);
  if (placeQueue.length) beginQueuePlacement();
  else if (view.session) showWorldLayer();
  else showMenuLayer();
}

function mountLiveDish(view, menu, dishId) {
  retireUnpinnedLive(view);
  const token = (view.liveToken || 0) + 1;
  view.liveToken = token;
  const shadow = new THREE.Mesh(
    new THREE.CircleGeometry(0.48, 40),
    new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.28, depthWrite: false })
  );
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.y = 0.01;
  shadow.name = "shadow";
  const placed = new THREE.Group();
  placed.add(shadow);
  placed.userData.menu = menu;
  placed.userData.dishId = dishId;
  placed.visible = false;
  view.scene.add(placed);
  view.placed = placed;
  view.model = null;
  view.shadow = shadow;
  view.menu = menu;
  view.dishId = dishId;
  view.liveDishId = dishId;
  view.anchor = null;
  view.anchorSlot = null;
  view.dishPlaced = false;
  view.placing = false;
  view.placeRequested = false;
  view.liveReady = true;
  view.suspendPlace = false;
  view.surfaceSeen = false;
  view.surfaceValid = false;
  view.blockedSurface = false;
  view.blockedOverlap = false;
  view.overlapSeen = false;
  view.liveRadius = 0.22;
  setViewerHint(queueScanHint(menu, dishId));
  loadDishModel(dishId).then((loaded) => {
    if (view.liveToken !== token || view.placed !== placed) return;
    placed.add(loaded);
    view.model = loaded;
    setDishScale(view, DISH_SCALE_AR);
    view.liveRadius = worldFootprint(placed);
    if (!view.dishPlaced) {
      setViewerHint(view.surfaceValid ? copyOf(menu).placeHint : queueScanHint(menu, dishId));
    }
  }).catch(() => {
    if (view.liveToken !== token || view.placed !== placed) return;
    skipFailedDish(view, menu);
  });
}

function lockDish(view, copy, hit, referenceSpace) {
  if (!view.model || !view.placed || view.dishPlaced || view.placing) return;
  const pose = hit.getPose(referenceSpace);
  if (!pose || !isHorizontalSurface(pose.transform.matrix)) return;
  const snapshot = new Float32Array(pose.transform.matrix);
  view.placing = true;
  view.dishPlaced = true;
  view.surfaceValid = false;
  view.reticle.visible = false;
  applyLockedMatrix(view, snapshot);
  setDishScale(view, DISH_SCALE_AR);
  view.placed.visible = true;
  view.placed.userData.menu = view.menu;
  view.placed.userData.dishId = view.dishId;
  view.liveRadius = worldFootprint(view.placed);
  const slot = { anchor: null, cancelled: false };
  view.anchorSlot = slot;
  view.anchor = null;
  commitPlacedDish(view);
  if (typeof hit.createAnchor !== "function") return;
  try {
    hit.createAnchor().then((anchor) => {
      if (slot.cancelled || active !== view || !view.session) {
        anchor.delete?.();
        return;
      }
      slot.anchor = anchor;
    }).catch(() => {});
  } catch {
    /* El plato ya quedó anclado en espacio local. */
  }
}

function stickGroup(group, anchor, frame, referenceSpace) {
  if (!group || !anchor || !frame || !referenceSpace) return;
  const pose = frame.getPose(anchor.anchorSpace, referenceSpace);
  if (!pose) return;
  _eyeWorld.fromArray(pose.transform.matrix);
  _eyeWorld.decompose(_hitPos, _hitQuat, _hitScale);
  _hitEuler.setFromQuaternion(_hitQuat, "YXZ");
  if (group.position.distanceToSquared(_hitPos) > 0.0004) group.position.copy(_hitPos);
  const yawDelta = Math.atan2(
    Math.sin(_hitEuler.y - group.rotation.y),
    Math.cos(_hitEuler.y - group.rotation.y)
  );
  if (Math.abs(yawDelta) > 0.05) group.rotation.y = _hitEuler.y;
  group.scale.set(1, 1, 1);
  group.updateMatrix();
}

function stickDish(view, frame) {
  const referenceSpace = view.renderer.xr.getReferenceSpace();
  if (!referenceSpace) return;
  for (const pin of world.pinned) stickGroup(pin.group, pin.slot?.anchor, frame, referenceSpace);
  if (view.dishPlaced && view.placed && view.anchor) stickGroup(view.placed, view.anchor, frame, referenceSpace);
}

function tryPlaceDish(view) {
  if (!view.session || !view.liveReady || view.suspendPlace || view.dishPlaced || view.placing) return;
  if (!view.model) {
    showViewerAlert(copyOf(view.menu).modelLoading);
    return;
  }
  view.placeRequested = true;
}

function finishSession(view) {
  cancelSource(view.hitTestSource);
  view.hitTestSource = null;
  view.hitTestSourceRequested = false;
  view.overlay?.removeEventListener("pointerdown", view.onPlacePointer);
  if (view.overlay) view.overlay.style.pointerEvents = "";
  releaseWorld(view);
  if (view.anchorSlot) view.anchorSlot.cancelled = true;
  view.anchor?.delete?.();
  view.anchor = null;
  view.anchorSlot = null;
  view.session = null;
  view.starting = false;
  view.liveReady = false;
  view.renderer.setAnimationLoop(null);
  placeQueue.length = 0;
  if (active !== view) return;
  viewerEl()?.classList.remove("is-live", "is-placing", "is-detail");
  showMenuLayer();
  if (view.menu) paintShell(view.menu, shellState());
}

function updateHitTest(view, copy, frame) {
  if (!view.liveReady || view.suspendPlace) {
    view.reticle.visible = false;
    view.surfaceValid = false;
    view.blockedOverlap = false;
    return null;
  }
  if (view.dishPlaced) {
    view.reticle.visible = false;
    view.surfaceValid = false;
    return null;
  }

  const referenceSpace = view.renderer.xr.getReferenceSpace();
  if (!view.hitTestSource || !referenceSpace) {
    view.blockedSurface = false;
    showSearchReticle(view);
    return null;
  }

  const hit = frame.getHitTestResults(view.hitTestSource)[0];
  const pose = hit?.getPose(referenceSpace);
  if (!pose) {
    view.blockedSurface = false;
    showSearchReticle(view);
    if (view.surfaceSeen) {
      view.surfaceSeen = false;
      setViewerHint(copy.scanHint);
    }
    return null;
  }

  const horizontal = isHorizontalSurface(pose.transform.matrix);
  placeReticle(view, pose.transform.matrix, horizontal);
  const overlap = horizontal && overlapsPins(view.reticle.position, liveRadiusOf(view));
  const valid = horizontal && !overlap;
  view.blockedSurface = !horizontal;
  view.blockedOverlap = overlap;
  view.surfaceValid = valid;
  view.reticle.material.color.setHex(overlap ? RETICLE_BLOCK : valid ? RETICLE_READY : RETICLE_SCAN);
  if (overlap) {
    if (!view.overlapSeen) {
      view.overlapSeen = true;
      view.surfaceSeen = false;
      setViewerHint(copy.overlapHint);
    }
    return null;
  }
  if (view.overlapSeen) view.overlapSeen = false;
  if (!view.model) {
    setViewerHint(copy.modelLoading);
  } else if (valid && !view.surfaceSeen) {
    view.surfaceSeen = true;
    setViewerHint(copy.placeHint);
  } else if (!valid && view.surfaceSeen) {
    view.surfaceSeen = false;
    setViewerHint(copy.scanHint);
  }
  return valid ? hit : null;
}

function depthPixelCount(depthInfo) {
  const width = depthInfo.width | 0;
  const height = depthInfo.height | 0;
  if (width < 2 || height < 2) return 0;
  return width * height;
}

function uploadCpuDepth(view, depthInfo) {
  const texture = view.depthQuad?.userData.depthTexture2D;
  const count = depthPixelCount(depthInfo);
  const buffer = depthInfo.data;
  if (!texture || !count || !buffer) return false;
  const scale = depthInfo.rawValueToMeters > 0 ? depthInfo.rawValueToMeters : 1;
  const format = view.session?.depthDataFormat;
  let source = null;
  if (ArrayBuffer.isView(buffer) && buffer.length >= count) {
    source = buffer;
  } else if (format === "float32" && buffer.byteLength >= count * 4) {
    source = new Float32Array(buffer, 0, count);
  } else if (buffer.byteLength >= count * 2) {
    source = new Uint16Array(buffer, 0, count);
  }
  if (!source) return false;
  if (!view.depthPixels || view.depthPixels.length !== count) {
    view.depthPixels = new Float32Array(count);
  }
  const meters = view.depthPixels;
  let finite = 0;
  for (let i = 0; i < count; i += 1) {
    const value = source[i] * scale;
    if (value > 0.02 && value < 8) {
      meters[i] = value;
      finite += 1;
    } else {
      meters[i] = 0;
    }
  }
  if (finite < 32) return false;
  const width = depthInfo.width | 0;
  const height = depthInfo.height | 0;
  texture.image = { data: meters, width, height };
  texture.needsUpdate = true;
  const mapping = depthInfo.normDepthBufferFromNormView?.matrix;
  const uniform = view.depthQuad.material.uniforms.uViewToDepth.value;
  if (mapping) uniform.fromArray(mapping);
  else uniform.identity();
  view.depthQuad.material.uniforms.uMetersInRed.value = 1;
  view.depthQuad.userData.externalDepth = null;
  const occ = occlusionUniforms(view);
  occ.uOcclusionDepth.value = texture;
  occ.uOcclusionMetersInRed.value = 1;
  occ.uOcclusionRawToMeters.value = 1;
  occ.uOcclusionPack.value = 0;
  if (mapping) occ.uOcclusionViewToDepth.value.fromArray(mapping);
  else occ.uOcclusionViewToDepth.value.identity();
  setOcclusionActive(view, true);
  return true;
}

function depthBinding(view) {
  if (view.depthBinding || view.depthBinding === null) return view.depthBinding;
  if (typeof XRWebGLBinding === "undefined" || !view.session) {
    view.depthBinding = null;
    return null;
  }
  try {
    view.depthBinding = new XRWebGLBinding(view.session, view.renderer.getContext());
  } catch {
    view.depthBinding = null;
  }
  return view.depthBinding;
}

function gpuDepthInfo(view, xrView) {
  if (view.session.depthUsage === "cpu-optimized") return null;
  const binding = depthBinding(view);
  if (!binding || typeof binding.getDepthInformation !== "function") return null;
  try {
    const info = binding.getDepthInformation(xrView);
    if (info?.texture && info.isValid !== false) return info;
  } catch {
    return null;
  }
  return null;
}

function prepareOcclusion(view, frame) {
  view.gpuDepth = null;
  if (view.occluder) view.occluder.visible = false;
  if (view.depthQuad) view.depthQuad.visible = false;
  setOcclusionActive(view, false);
  const referenceSpace = view.renderer.xr.getReferenceSpace();
  if (!referenceSpace || !view.depthQuad) return;
  const pose = frame.getViewerPose(referenceSpace);
  const xrView = pose?.views?.[0];
  if (!xrView) return;
  view.occlusionProj = xrView.projectionMatrix;

  if (typeof frame.getDepthInformation === "function") {
    let depth = null;
    try {
      depth = frame.getDepthInformation(xrView);
    } catch {
      depth = null;
    }
    if (depth && uploadCpuDepth(view, depth)) {
      view.depthQuad.material.uniforms.uUseArray.value = 0;
      view.depthQuad.visible = false;
      return;
    }
  }

  const gpu = gpuDepthInfo(view, xrView);
  if (gpu?.texture) {
    view.gpuDepth = gpu;
    view.occlusionLayer = Math.max(0, pose.views.indexOf(xrView));
    view.depthQuad.userData.externalDepth = gpu;
    view.depthQuad.material.uniforms.uMetersInRed.value = 0;
    view.depthQuad.material.uniforms.uUseArray.value = gpu.textureType === "texture-array" ? 1 : 0;
    view.depthQuad.material.uniforms.uLayer.value = view.occlusionLayer;
    const mapping = gpu.normDepthBufferFromNormView?.matrix;
    const uniform = view.depthQuad.material.uniforms.uViewToDepth.value;
    if (mapping) uniform.fromArray(mapping);
    else uniform.identity();
    const occ = occlusionUniforms(view);
    occ.uOcclusionMetersInRed.value = 0;
    occ.uOcclusionRawToMeters.value = gpu.rawValueToMeters > 0 ? gpu.rawValueToMeters : 1;
    occ.uOcclusionPack.value = view.session?.depthDataFormat === "luminance-alpha" || view.session?.depthDataFormat === "unsigned-short" ? 1 : 0;
    if (mapping) occ.uOcclusionViewToDepth.value.fromArray(mapping);
    else occ.uOcclusionViewToDepth.value.identity();
    if (gpu.textureType !== "texture-array") {
      occ.uOcclusionDepth.value = view.depthQuad.userData.depthTexture2D;
      setOcclusionActive(view, true);
    }
    view.depthQuad.visible = false;
    return;
  }

  view.depthQuad.visible = false;
}

function drawXR(view, copy, frame) {
  if (!frame || active !== view) return;
  try {
    const hit = updateHitTest(view, copy, frame);
    if (view.placeRequested && !view.dishPlaced && !view.placing) {
      view.placeRequested = false;
      if (view.liveReady && !view.suspendPlace) {
        const referenceSpace = view.renderer.xr.getReferenceSpace();
        if (hit && referenceSpace) lockDish(view, copy, hit, referenceSpace);
        else showViewerAlert(view.blockedOverlap ? copy.overlapAlert : view.blockedSurface ? copy.wallHint : copy.missHint);
      }
    }
    stickDish(view, frame);
    try {
      prepareOcclusion(view, frame);
    } catch (error) {
      if (view.occluder) view.occluder.visible = false;
      if (view.depthQuad) view.depthQuad.visible = false;
      console.warn("Oclusión", error);
    }
  } catch (error) {
    console.warn("Frame AR", error);
  }
  view.renderer.render(view.scene, view.camera);
}

function beginScan() {
  const view = active;
  if (!view || view.session || view.starting) return;
  const copy = copyOf(view.menu);
  if (view.arReady === false) {
    showToast(copy.arUnsupported);
    return;
  }
  const viewer = viewerEl();
  viewer?.classList.add("is-live");
  const overlay = app.querySelector(".viewer-overlay");
  const hud = app.querySelector(".xr-hud");
  if (hud) hud.hidden = false;
  view.starting = true;
  prefetchQueueModels();
  if (view.model) view.model.rotation.y = 0;
  let pending;
  try {
    const sessionInit = {
      requiredFeatures: ["hit-test"],
      optionalFeatures: ["dom-overlay", "anchors"],
      domOverlay: overlay ? { root: overlay } : undefined,
    };
    pending = navigator.xr.requestSession("immersive-ar", sessionInit).catch((error) => {
      if (error?.name === "NotAllowedError" || error?.name === "SecurityError") throw error;
      const fallback = {
        requiredFeatures: ["hit-test"],
        optionalFeatures: ["dom-overlay"],
        domOverlay: overlay ? { root: overlay } : undefined,
      };
      return navigator.xr.requestSession("immersive-ar", fallback);
    });
  } catch (error) {
    view.starting = false;
    viewer?.classList.remove("is-live");
    showViewerAlert(arErrorMessage(error, copy));
    return;
  }

  pending.then(async (session) => {
    if (active !== view) {
      session.end().catch(() => {});
      return;
    }
    view.session = session;
    view.starting = false;
    guardDepthBinding();
    useLayerDepthBuffer();
    hideDepthFromRenderer(session);
    session.addEventListener("end", () => finishSession(view));
    cancelAnimationFrame(view.frame);
    view.studio = false;
    applyViewerLighting(view, false);
    view.dishPlaced = false;
    if (view.placed) view.placed.visible = false;
    if (view.reticle) view.reticle.visible = false;
    view.surfaceSeen = false;
    view.surfaceValid = false;
    view.blockedSurface = false;
    view.blockedOverlap = false;
    view.overlapSeen = false;
    view.placeRequested = false;
    view.placing = false;
    view.liveReady = false;
    view.liveDishId = null;
    view.suspendPlace = true;
    view.liveRadius = footprintAtARScale(view);
    view.lastPointerAt = 0;
    view.renderer.xr.enabled = true;
    view.renderer.xr.setReferenceSpaceType("local");
    await view.renderer.xr.setSession(session);
    if (active !== view) return;

    view.hitTestSourceRequested = true;
    const viewerSpace = await session.requestReferenceSpace("viewer");
    if (view.session !== session) return;
    view.hitTestSource = await session.requestHitTestSource({ space: viewerSpace });
    if (active !== view) return;

    view.onPlacePointer = (event) => {
      if (!view.session) return;
      if (isHudEvent(event)) {
        view.lastPointerAt = performance.now();
        view.suppressPlace = true;
        return;
      }
      view.lastPointerAt = performance.now();
      if (selectDishAtPointer(view, event)) {
        view.suppressPlace = true;
        return;
      }
      tryPlaceDish(view);
    };
    view.overlay = overlay;
    if (overlay) overlay.style.pointerEvents = "auto";
    overlay?.addEventListener("pointerdown", view.onPlacePointer);
    session.addEventListener("select", (event) => {
      if (view.suppressPlace || performance.now() - view.lastPointerAt < 400) {
        view.suppressPlace = false;
        return;
      }
      if (selectAlongXR(view, event)) return;
      tryPlaceDish(view);
    });

    syncArButton();
    if (placeQueue.length) beginQueuePlacement();
    else showMenuLayer();
    view.renderer.setAnimationLoop((time, frame) => drawXR(view, copy, frame));
  }).catch((error) => {
    const session = view.session;
    view.starting = false;
    view.session = null;
    session?.end().catch(() => {});
    viewerEl()?.classList.remove("is-live");
    if (active !== view) return;
    const message = arErrorMessage(error, copy);
    showViewerAlert(message);
    showToast(message);
  });
}

function setupThree(canvas) {
  const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
  renderer.setClearColor(0x000000, 0);
  if (THREE.SRGBColorSpace) renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.toneMappingExposure = VIEWER_LIGHT_STUDIO.exposure;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 40);
  camera.position.set(0.15, 2.15, 6.4);
  camera.lookAt(0, 0.18, 0);

  const hemi = new THREE.HemisphereLight(0xffffff, 0xb8aea4, VIEWER_LIGHT_STUDIO.hemi);
  scene.add(hemi);
  const ambient = new THREE.AmbientLight(0xffffff, VIEWER_LIGHT_STUDIO.ambient);
  scene.add(ambient);
  const key = new THREE.DirectionalLight(0xffffff, VIEWER_LIGHT_STUDIO.key);
  key.position.set(2.4, 4.2, 2.2);
  scene.add(key);
  const fill = new THREE.DirectionalLight(0xfff0e0, VIEWER_LIGHT_STUDIO.fill);
  fill.position.set(-2.8, 1.4, -1.6);
  scene.add(fill);
  const bounce = new THREE.DirectionalLight(0xffe8d0, 1.8);
  bounce.position.set(0.4, -0.6, 3.2);
  scene.add(bounce);
  const rim = new THREE.DirectionalLight(0xffffff, VIEWER_LIGHT_STUDIO.rim);
  rim.position.set(0.8, 2.8, 4.6);
  scene.add(rim);

  const ring = new THREE.RingGeometry(0.07, 0.105, 48);
  ring.rotateX(-Math.PI / 2);
  const reticle = new THREE.Mesh(
    ring,
    new THREE.MeshBasicMaterial({ color: RETICLE_SCAN, side: THREE.DoubleSide, depthWrite: false })
  );
  reticle.visible = false;
  reticle.renderOrder = 2;
  scene.add(reticle);

  const occluder = null;
  const depthQuad = createDepthQuad();
  scene.add(depthQuad);

  function resize() {
    if (renderer.xr.isPresenting) return;
    const width = canvas.clientWidth || 1;
    const height = canvas.clientHeight || 1;
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  }
  resize();
  const observer = new ResizeObserver(resize);
  observer.observe(canvas);

  const view = {
    renderer,
    scene,
    camera,
    model: null,
    shadow: null,
    placed: null,
    reticle,
    occluder,
    depthQuad,
    observer,
    onUp() {},
    resize,
    studio: false,
    lights: { hemi, key, fill, rim, ambient, bounce },
    arReady: null,
    frame: 0,
    start() {
      resize();
    },
  };

  const depthTexture2D = depthQuad.userData.depthTexture2D;
  function bindOcclusionTextures(activeRenderer) {
    const gl = activeRenderer.getContext();
    const vp = gl.getParameter(gl.VIEWPORT);
    const uniforms = depthQuad.material.uniforms;
    uniforms.uViewport.value.set(vp[0], vp[1], Math.max(vp[2], 1), Math.max(vp[3], 1));
    occlusionUniforms(view).uOcclusionViewport.value.set(
      vp[0],
      vp[1],
      Math.max(vp[2], 1),
      Math.max(vp[3], 1)
    );
    const proj = view.occlusionProj;
    if (proj) uniforms.uProjZ.value.set(proj[10], proj[14], proj[11], proj[15]);
    const info = view.gpuDepth;
    if (!info?.texture) return;
    const isArray = info.textureType === "texture-array";
    const target = isArray ? depthQuad.userData.depthTextureArray : depthTexture2D;
    if (!target) return;
    const props = activeRenderer.properties.get(target);
    props.__webglTexture = info.texture;
    props.__version = target.version;
    uniforms.uUseArray.value = isArray ? 1 : 0;
    uniforms.uLayer.value = view.occlusionLayer || 0;
    uniforms.uMetersInRed.value = 0;
    uniforms.uRawToMeters.value = info.rawValueToMeters > 0 ? info.rawValueToMeters : 1;
    uniforms.uPack.value = view.session?.depthDataFormat === "luminance-alpha" || view.session?.depthDataFormat === "unsigned-short" ? 1 : 0;
  }
  depthQuad.onBeforeRender = bindOcclusionTextures;
  scene.onBeforeRender = bindOcclusionTextures;

  return view;
}

function bindFactsScroller() {
  const scroller = app.querySelector("[data-facts-scroller]");
  const button = app.querySelector("[data-facts-next]");
  if (!scroller || !button || !active) return;

  const maxScroll = () => Math.max(0, scroller.scrollWidth - scroller.clientWidth);
  const atEnd = () => maxScroll() > 8 && scroller.scrollLeft >= maxScroll() - 12;

  const sync = () => {
    const overflow = maxScroll() > 8;
    button.hidden = !overflow;
    const ended = atEnd();
    button.classList.toggle("is-back", ended);
    button.setAttribute("aria-label", ended ? button.dataset.backLabel : button.dataset.nextLabel);
  };

  button.addEventListener("click", () => {
    const max = maxScroll();
    if (atEnd()) {
      scroller.scrollTo({ left: 0, behavior: "smooth" });
      button.classList.remove("is-back");
      button.setAttribute("aria-label", button.dataset.nextLabel);
      return;
    }
    const next = Math.min(max, scroller.scrollLeft + Math.max(112, Math.round(scroller.clientWidth * 0.72)));
    scroller.scrollTo({ left: next, behavior: "smooth" });
    const ended = next >= max - 12;
    button.classList.toggle("is-back", ended);
    button.setAttribute("aria-label", ended ? button.dataset.backLabel : button.dataset.nextLabel);
  });
  scroller.addEventListener("scroll", sync, { passive: true });
  scroller.addEventListener("scrollend", sync);
  active.factsObserver = new ResizeObserver(sync);
  active.factsObserver.observe(scroller);
  active.syncFacts = sync;
  sync();
}

async function copySlug(button) {
  const url = slugUrl(button.dataset.code);
  const label = button.dataset.label || "Copiar";
  const done = button.dataset.done || "Copiado";
  const select = button.dataset.select || "Selecciona";
  const code = button.parentElement?.querySelector("code");
  try {
    await navigator.clipboard.writeText(url);
    button.textContent = done;
  } catch {
    if (code) {
      const range = document.createRange();
      range.selectNodeContents(code);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    }
    button.textContent = select;
  }
  window.setTimeout(() => {
    button.textContent = label;
  }, 1600);
}

let holdX = 0;
let holdY = 0;

function onPointerDown(event) {
  const dish = event.target.closest("[data-pick-dish]");
  if (!dish || pickMode) return;
  holdFired = false;
  holdX = event.clientX;
  holdY = event.clientY;
  const id = dish.dataset.dish;
  const menu = dish.dataset.menu;
  window.clearTimeout(holdTimer);
  holdTimer = window.setTimeout(() => {
    holdTimer = 0;
    holdFired = true;
    pickMode = true;
    pickedIds = [id];
    applyPickState(menu);
  }, 450);
}

function onPointerMove(event) {
  if (!holdTimer) return;
  if (Math.hypot(event.clientX - holdX, event.clientY - holdY) > 12) {
    window.clearTimeout(holdTimer);
    holdTimer = 0;
  }
}

function onPointerEnd() {
  window.clearTimeout(holdTimer);
  holdTimer = 0;
}

function onClick(event) {
  if (holdFired) {
    holdFired = false;
    if (event.target.closest("[data-pick-dish]")) {
      event.preventDefault();
      return;
    }
  }

  const nav = event.target.closest("a[data-nav]");
  if (nav) {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
    event.preventDefault();
    history.pushState({}, "", nav.href);
    render();
    return;
  }

  const pick = event.target.closest("[data-pick-dish]");
  if (pick) {
    event.preventDefault();
    const menu = pick.dataset.menu;
    const id = pick.dataset.dish;
    if (pickMode) {
      togglePicked(id);
      applyPickState(menu);
      return;
    }
    queryAR().then((supported) => {
      if (active) active.arReady = supported;
      syncArButton();
      if (!supported) {
        showDishInfo(menu, id);
        return;
      }
      setPlaceQueue([makeQueueItem(menu, id)]);
      startPlacement();
    });
    return;
  }

  if (active?.session && event.target.closest(".viewer-back, .viewer-card, .viewer-order")) {
    active.suppressPlace = true;
  }

  const action = event.target.closest("[data-action]");
  if (action?.dataset.action === "set-lang") {
    const { menu, lang } = action.dataset;
    if ((menu === "pe" || menu === "br") && (lang === "es" || lang === "pt") && lang !== menuLang(menu)) {
      setMenuLang(menu, lang);
      render();
    }
    return;
  }
  if (action?.dataset.action === "copy-slug") copySlug(action);
  if (action?.dataset.action === "start-ar") {
    if (active?.session) showMenuLayer();
    else beginScan();
    return;
  }
  if (action?.dataset.action === "place-queue") {
    const menu = action.dataset.menu;
    setPlaceQueue(pickedIds.map((id) => makeQueueItem(menu, id)));
    pickMode = false;
    pickedIds = [];
    applyPickState(menu);
    startPlacement();
    return;
  }
  if (action?.dataset.action === "resume-queue") {
    startPlacement();
    return;
  }
  if (action?.dataset.action === "cancel-pick") {
    pickMode = false;
    pickedIds = [];
    applyPickState(active?.menu || route().menu);
    return;
  }
  if (action?.dataset.action === "show-menu") {
    if (active?.session) retireUnpinnedLive(active);
    showMenuLayer();
    paintShell(active?.menu || route().menu, shellState());
    return;
  }
  if (action?.dataset.action === "remove-dish") {
    removeSelectedDish();
    return;
  }
  if (action?.dataset.action === "add-dish") {
    const { menu, dish } = action.dataset;
    const qty = addToCart(menu, dish);
    paintAddButton(action, qty);
    showToast(copyOf(menu).addedToast);
  }
  if (action?.dataset.action === "view-order") {
    event.preventDefault();
    history.pushState({}, "", appHref(action.dataset.menu, null, true));
    render();
    return;
  }
  if (action?.dataset.action === "cart-inc") {
    const qty = cartQty(action.dataset.menu, action.dataset.dish) + 1;
    setCartQty(action.dataset.menu, action.dataset.dish, qty);
    render();
    return;
  }
  if (action?.dataset.action === "cart-dec") {
    const qty = cartQty(action.dataset.menu, action.dataset.dish) - 1;
    setCartQty(action.dataset.menu, action.dataset.dish, qty);
    render();
    return;
  }
  if (action?.dataset.action === "place-order") {
    const menu = action.dataset.menu;
    clearCartForMenu(menu);
    const menuSlot = app.querySelector(".xr-menu");
    if (menuSlot && app.querySelector(".viewer")) {
      showMenuLayer();
      menuSlot.innerHTML = pedidoPlacedView(menu);
      menuSlot.scrollTop = 0;
      return;
    }
    app.innerHTML = pedidoPlacedView(menu);
    window.scrollTo(0, 0);
    return;
  }
}

app.addEventListener("click", onClick);
app.addEventListener("pointerdown", onPointerDown);
app.addEventListener("pointermove", onPointerMove);
app.addEventListener("pointerup", onPointerEnd);
app.addEventListener("pointercancel", onPointerEnd);
app.addEventListener("contextmenu", (event) => {
  if (event.target.closest("[data-pick-dish]")) event.preventDefault();
});
window.addEventListener("popstate", render);
window.addEventListener("pagehide", stopViewer);
render();
