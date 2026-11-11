import * as THREE from "https://cdn.jsdelivr.net/npm/three@0.170.0/build/three.module.js";
import { MENUS, UI, findDish, dishCount } from "./menus.js";
import { createDishModel } from "./models.js";

const app = document.querySelector("#app");

const RETICLE_SCAN = 0xffcc33;
const RETICLE_READY = 0x3ddc6a;
const OCCLUSION_COLS = 32;
const OCCLUSION_ROWS = 24;

const _hitPos = new THREE.Vector3();
const _hitQuat = new THREE.Quaternion();
const _hitScale = new THREE.Vector3();
const _hitEuler = new THREE.Euler();
const _searchPos = new THREE.Vector3();
const _searchQuat = new THREE.Quaternion();
const _viewFromDepth = new THREE.Matrix4();
const _eyeWorld = new THREE.Matrix4();
const _occlPoint = new THREE.Vector3();

let generation = 0;
let active = null;
let arSupport = null;

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
  const copy = UI[button.dataset.menu];
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

function render() {
  const { menu, plato, pedido } = route();
  const copy = menu ? UI[menu] : null;
  document.documentElement.lang = copy ? copy.htmlLang : "es";
  document.title = copy
    ? pedido
      ? `MESA — ${copy.orderTitle}`
      : `MESA — ${copy.carta}`
    : "MESA — Carta aumentada";

  const found = menu && plato ? findDish(menu, plato) : null;
  const sameDish = found && active && active.menu === menu && active.dishId === found.dish.id && app.querySelector(".viewer");
  if (sameDish) return;

  stopViewer();

  if (!menu) app.innerHTML = landing();
  else if (pedido) app.innerHTML = pedidoView(menu);
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
      <p>${esc(copy.kitchen)} · ${dishCount(menu)} ${menu === "pe" ? "platos y bebidas" : "pratos"}</p>
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
      <article class="sheet sheet-pad menu-card" data-accent="${menu}">
        <header class="mast menu-mast">
          <p class="resto">${esc(copy.restaurant)}</p>
          <p class="brand">MESA ${esc(tableLabel())}</p>
          <div class="flourish" aria-hidden="true"><span></span></div>
          <h1>${esc(copy.carta)}</h1>
          <p class="kitchen">${esc(copy.kitchen)}</p>
        </header>
        ${sections}
        <button class="order-btn" type="button" data-action="view-order" data-menu="${esc(menu)}">
          <span>${esc(copy.viewOrder)}</span>
          ${cartItemCount(menu) ? `<span class="order-badge" aria-hidden="true">${cartItemCount(menu)}</span>` : ""}
        </button>
      </article>
    </div>
  `;
}

function pedidoView(menu) {
  const copy = UI[menu];
  const items = cartForMenu(menu);
  const lines = items.map((entry) => {
    const found = findDish(menu, entry.id);
    if (!found) return "";
    const { dish } = found;
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
  const copy = UI[menu];
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

function viewerMarkup(menu, section, dish) {
  const copy = UI[menu];
  const qty = cartQty(menu, dish.id);
  const nutrients = copy.nutrients.map((item) => `
    <div>
      <dt>${esc(item.label)}</dt>
      <dd>${esc(dish.nutrition[item.key])} ${esc(item.unit)}</dd>
    </div>
  `).join("");

  return `
    <section class="viewer" data-accent="${menu}">
      <canvas class="viewer-canvas" data-model="${esc(dish.id)}" aria-label="${esc(dish.name)}"></canvas>
      <div class="viewer-overlay">
      <a class="viewer-back" data-nav href="${esc(appHref(menu))}">
        <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M10 3 L5 8 L10 13" fill="none" stroke="currentColor" stroke-width="1.6"></path></svg>
        ${esc(copy.back)}
      </a>
      <button class="viewer-order" type="button" data-action="view-order" data-menu="${esc(menu)}">
        <span>${esc(copy.viewOrder)}</span>
        ${cartItemCount(menu) ? `<span class="viewer-order-badge" aria-hidden="true">${cartItemCount(menu)}</span>` : ""}
      </button>
      <p class="viewer-hint">${esc(copy.scanReady)}</p>
      <p class="viewer-alert" hidden></p>
      <button class="viewer-scan" type="button" data-action="start-ar" hidden>${esc(copy.scan)}</button>
      <div class="viewer-card">
        <div class="viewer-heading">
          <h1>${esc(dish.name)}</h1>
          <p class="price-lg">${esc(price(menu, dish.price))}</p>
          <button class="viewer-add${qty ? " is-added" : ""}" type="button" data-action="add-dish" data-menu="${esc(menu)}" data-dish="${esc(dish.id)}" aria-label="${esc(qty ? addedLabel(copy, qty) : copy.add)}">
            <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M8 2.5 V13.5 M2.5 8 H13.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"></path></svg>
            <span class="viewer-add-label">${esc(copy.add)}</span>
            <span class="viewer-add-count"${qty ? "" : " hidden"}>${qty || ""}</span>
          </button>
        </div>
        <div class="viewer-facts">
          <div class="viewer-facts-scroller" data-facts-scroller>
            <div class="viewer-facts-track">
              <p class="portion">${esc(dish.portion)} · ${esc(section.title)}</p>
              <dl class="nutrition">${nutrients}</dl>
              <p class="viewer-allergens">${esc(copy.allergensTitle)}: ${dish.allergens.length ? esc(dish.allergens.join(", ")) : esc(copy.noAllergens)}</p>
            </div>
          </div>
          <button class="viewer-facts-next" type="button" data-facts-next data-next-label="${esc(copy.factsNext)}" data-back-label="${esc(copy.factsBack)}" aria-label="${esc(copy.factsNext)}" hidden>
            <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M6 3 L11 8 L6 13" fill="none" stroke="currentColor" stroke-width="1.6"></path></svg>
          </button>
        </div>
      </div>
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

function stopViewer() {
  generation += 1;
  const current = active;
  active = null;
  if (!current) return;
  current.renderer?.setAnimationLoop(null);
  cancelAnimationFrame(current.frame);
  cancelSource(current.hitTestSource);
  current.hitTestSource = null;
  current.anchor?.delete?.();
  current.anchor = null;
  current.overlay?.removeEventListener("pointerdown", current.onPlacePointer);
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

function mountViewer(menu, dish) {
  const token = generation;
  const copy = UI[menu];
  const canvas = app.querySelector(".viewer-canvas");
  if (!canvas) return;

  const view = setupThree(canvas, dish.id, token);
  view.menu = menu;
  view.dishId = dish.id;
  active = view;
  bindFactsScroller();
  view.start();

  queryAR().then((supported) => {
    if (generation !== token || active !== view) return;
    view.arReady = supported;
    const scan = app.querySelector(".viewer-scan");
    if (supported) {
      if (scan) scan.hidden = false;
      setViewerHint(copy.scanReady);
      return;
    }
    if (scan) scan.hidden = true;
    setViewerHint(`${copy.arUnsupported} ${copy.spinHint}`);
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

function createOccluder() {
  const positions = new Float32Array(OCCLUSION_COLS * OCCLUSION_ROWS * 3);
  const indices = new Uint16Array((OCCLUSION_COLS - 1) * (OCCLUSION_ROWS - 1) * 6);
  let n = 0;
  for (let y = 0; y < OCCLUSION_ROWS - 1; y += 1) {
    for (let x = 0; x < OCCLUSION_COLS - 1; x += 1) {
      const a = y * OCCLUSION_COLS + x;
      indices[n] = a;
      indices[n + 1] = a + OCCLUSION_COLS;
      indices[n + 2] = a + 1;
      indices[n + 3] = a + 1;
      indices[n + 4] = a + OCCLUSION_COLS;
      indices[n + 5] = a + OCCLUSION_COLS + 1;
      n += 6;
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  const mesh = new THREE.Mesh(
    geometry,
    new THREE.MeshBasicMaterial({
      colorWrite: false,
      depthWrite: true,
      depthTest: true,
      side: THREE.DoubleSide,
    })
  );
  mesh.frustumCulled = false;
  mesh.renderOrder = -1000;
  mesh.visible = false;
  mesh.name = "occluder";
  return mesh;
}

function createDepthQuad() {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array([
    -1, -1, 0,
    3, -1, 0,
    -1, 3, 0,
  ]), 3));
  const depthTexture = new THREE.DataArrayTexture(new Uint8Array([0, 0, 0, 0]), 1, 1, 1);
  depthTexture.generateMipmaps = false;
  depthTexture.flipY = false;
  depthTexture.magFilter = THREE.NearestFilter;
  depthTexture.minFilter = THREE.NearestFilter;
  depthTexture.wrapS = THREE.ClampToEdgeWrapping;
  depthTexture.wrapT = THREE.ClampToEdgeWrapping;
  depthTexture.needsUpdate = false;
  depthTexture.version = 0;
  const material = new THREE.ShaderMaterial({
    uniforms: {
      uDepth: { value: depthTexture },
      uViewToDepth: { value: new THREE.Matrix4() },
      uViewport: { value: new THREE.Vector4(0, 0, 1, 1) },
    },
    vertexShader: `
      attribute vec3 position;
      void main() {
        gl_Position = vec4(position.xy, 0.0, 1.0);
      }
    `,
    fragmentShader: `
      precision highp sampler2DArray;
      uniform sampler2DArray uDepth;
      uniform mat4 uViewToDepth;
      uniform vec4 uViewport;
      void main() {
        vec2 normView = vec2(
          (gl_FragCoord.x - uViewport.x) / uViewport.z,
          1.0 - (gl_FragCoord.y - uViewport.y) / uViewport.w
        );
        vec2 depthUv = clamp((uViewToDepth * vec4(normView, 0.0, 1.0)).xy, 0.0, 1.0);
        float d = texture(uDepth, vec3(depthUv, 0.0)).r;
        if (d <= 0.0) discard;
        gl_FragColor = vec4(0.0);
        gl_FragDepth = min(d + 0.002, 1.0);
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
  mesh.renderOrder = -1000;
  mesh.visible = false;
  mesh.name = "depthQuad";
  mesh.userData.depthTexture = depthTexture;
  return mesh;
}

function isHudEvent(event) {
  return Boolean(event.target.closest("button, a, input, select, label, .viewer-card"));
}

function setDishScale(view, scale) {
  view.model.scale.setScalar(scale);
  const shadowScale = scale / 0.36;
  view.shadow.scale.set(shadowScale, shadowScale, shadowScale);
}

function showStudio(view) {
  view.studio = true;
  view.surfaceSeen = false;
  view.surfaceValid = false;
  view.dishPlaced = false;
  view.placing = false;
  view.placeRequested = false;
  view.blockedSurface = false;
  view.anchor?.delete?.();
  view.anchor = null;
  view.placed.matrixAutoUpdate = true;
  view.placed.position.set(0, 0, 0);
  view.placed.rotation.set(0, 0, 0);
  view.placed.scale.set(1, 1, 1);
  view.placed.visible = true;
  setDishScale(view, 0.36);
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

function lockDish(view, copy, hit, referenceSpace) {
  if (view.dishPlaced || view.placing) return;
  const pose = hit.getPose(referenceSpace);
  if (!pose || !isHorizontalSurface(pose.transform.matrix)) return;
  const snapshot = new Float32Array(pose.transform.matrix);
  view.placing = true;
  view.dishPlaced = true;
  view.surfaceValid = false;
  view.reticle.visible = false;
  applyLockedMatrix(view, snapshot);
  setDishScale(view, 0.12);
  view.placed.visible = true;
  setViewerHint(copy.placedHint);
  const done = () => {
    view.placing = false;
  };
  if (typeof hit.createAnchor === "function") {
    try {
      hit.createAnchor().then((anchor) => {
        if (active !== view || !view.session || !view.dishPlaced) {
          anchor.delete?.();
          done();
          return;
        }
        view.anchor = anchor;
        done();
      }).catch(() => done());
    } catch {
      done();
    }
    return;
  }
  done();
}

function stickDish(view, frame) {
  if (!view.dishPlaced || !view.anchor || !frame) return;
  const referenceSpace = view.renderer.xr.getReferenceSpace();
  if (!referenceSpace) return;
  const pose = frame.getPose(view.anchor.anchorSpace, referenceSpace);
  if (!pose) return;
  _eyeWorld.fromArray(pose.transform.matrix);
  _eyeWorld.decompose(_hitPos, _hitQuat, _hitScale);
  _hitEuler.setFromQuaternion(_hitQuat, "YXZ");
  if (view.placed.position.distanceToSquared(_hitPos) > 0.0004) view.placed.position.copy(_hitPos);
  const yawDelta = Math.atan2(
    Math.sin(_hitEuler.y - view.placed.rotation.y),
    Math.cos(_hitEuler.y - view.placed.rotation.y)
  );
  if (Math.abs(yawDelta) > 0.05) view.placed.rotation.y = _hitEuler.y;
  view.placed.scale.set(1, 1, 1);
  view.placed.updateMatrix();
}

function tryPlaceDish(view) {
  if (!view.session || view.dishPlaced || view.placing) return;
  view.placeRequested = true;
}

function finishSession(view) {
  cancelSource(view.hitTestSource);
  view.hitTestSource = null;
  view.hitTestSourceRequested = false;
  view.anchor?.delete?.();
  view.anchor = null;
  view.overlay?.removeEventListener("pointerdown", view.onPlacePointer);
  view.session = null;
  view.starting = false;
  view.renderer.setAnimationLoop(null);
  if (active !== view) return;
  showStudio(view);
  const scan = app.querySelector(".viewer-scan");
  if (scan) scan.hidden = false;
  setViewerHint(UI[view.menu].scanReady);
  view.start();
}

function updateHitTest(view, copy, frame) {
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

  const valid = isHorizontalSurface(pose.transform.matrix);
  view.blockedSurface = !valid;
  placeReticle(view, pose.transform.matrix, valid);
  if (valid && !view.surfaceSeen) {
    view.surfaceSeen = true;
    setViewerHint(copy.placeHint);
  } else if (!valid && view.surfaceSeen) {
    view.surfaceSeen = false;
    setViewerHint(copy.scanHint);
  }
  return valid ? hit : null;
}

function depthSamples(depthInfo) {
  const width = depthInfo.width | 0;
  const height = depthInfo.height | 0;
  const count = width * height;
  if (!count) return null;
  const scale = depthInfo.rawValueToMeters > 0 ? depthInfo.rawValueToMeters : 1;
  const raw = depthInfo.data;
  if (raw instanceof ArrayBuffer && raw.byteLength >= count * 4) {
    return { values: new Float32Array(raw), scale, width, height };
  }
  if (ArrayBuffer.isView(raw) && raw.BYTES_PER_ELEMENT === 4 && raw.length >= count) {
    return { values: raw, scale, width, height };
  }
  return null;
}

function sampleDepth(depthInfo, packed, x, y) {
  if (packed) return packed.values[y * packed.width + x] * packed.scale;
  if (typeof depthInfo.getDepthInMeters !== "function") return 0;
  return depthInfo.getDepthInMeters(x, y);
}

function updateCpuOcclusion(view, depthInfo, xrView) {
  const mesh = view.occluder;
  const positions = mesh.geometry.attributes.position.array;
  const width = depthInfo.width | 0;
  const height = depthInfo.height | 0;
  if (width < 2 || height < 2) return;
  const mapping = depthInfo.normDepthBufferFromNormView?.matrix;
  if (mapping) {
    _viewFromDepth.fromArray(mapping);
    if (Math.abs(_viewFromDepth.determinant()) > 1e-8) _viewFromDepth.invert();
    else _viewFromDepth.identity();
  } else {
    _viewFromDepth.identity();
  }
  _eyeWorld.fromArray(xrView.transform.matrix);
  const proj = xrView.projectionMatrix;
  const p00 = proj[0];
  const p11 = proj[5];
  const p02 = proj[8];
  const p12 = proj[9];
  if (!p00 || !p11) return;

  const packed = depthSamples(depthInfo);
  let ptr = 0;
  let finite = 0;
  for (let y = 0; y < OCCLUSION_ROWS; y += 1) {
    const dv = (y + 0.5) / OCCLUSION_ROWS;
    for (let x = 0; x < OCCLUSION_COLS; x += 1) {
      const du = (x + 0.5) / OCCLUSION_COLS;
      const sx = Math.min(width - 1, Math.max(0, Math.round(du * (width - 1))));
      const sy = Math.min(height - 1, Math.max(0, Math.round(dv * (height - 1))));
      let meters = sampleDepth(depthInfo, packed, sx, sy);
      if (!Number.isFinite(meters) || meters <= 0 || meters > 8) meters = 8;
      else meters += 0.015;

      _occlPoint.set(du, dv, 0).applyMatrix4(_viewFromDepth);
      const ndcX = _occlPoint.x * 2 - 1;
      const ndcY = 1 - _occlPoint.y * 2;
      const viewX = (meters * (ndcX + p02)) / p00;
      const viewY = (meters * (ndcY + p12)) / p11;
      if (!Number.isFinite(viewX) || !Number.isFinite(viewY)) {
        positions[ptr] = 0;
        positions[ptr + 1] = 0;
        positions[ptr + 2] = 0;
      } else {
        _occlPoint.set(viewX, viewY, -meters).applyMatrix4(_eyeWorld);
        positions[ptr] = _occlPoint.x;
        positions[ptr + 1] = _occlPoint.y;
        positions[ptr + 2] = _occlPoint.z;
        finite += 1;
      }
      ptr += 3;
    }
  }

  mesh.geometry.attributes.position.needsUpdate = true;
  mesh.position.set(0, 0, 0);
  mesh.quaternion.identity();
  mesh.scale.set(1, 1, 1);
  mesh.updateMatrix();
  mesh.visible = finite > OCCLUSION_COLS;
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
  if (view.occlusionFailed) return;
  view.gpuDepth = null;
  const referenceSpace = view.renderer.xr.getReferenceSpace();
  if (!referenceSpace) return;
  const pose = frame.getViewerPose(referenceSpace);
  const xrView = pose?.views?.[0];
  if (!xrView) return;

  const gpu = gpuDepthInfo(view, xrView);
  if (gpu) {
    view.gpuDepth = gpu;
    view.depthQuad.visible = true;
    view.occluder.visible = false;
    return;
  }

  view.depthQuad.visible = false;
  if (typeof frame.getDepthInformation !== "function") return;
  let depth = null;
  try {
    depth = frame.getDepthInformation(xrView);
  } catch {
    depth = null;
  }
  if (!depth || (typeof depth.getDepthInMeters !== "function" && !depth.data)) return;
  updateCpuOcclusion(view, depth, xrView);
}

function drawXR(view, copy, frame) {
  if (!frame || active !== view) return;
  try {
    const hit = updateHitTest(view, copy, frame);
    if (view.placeRequested && !view.dishPlaced && !view.placing) {
      view.placeRequested = false;
      const referenceSpace = view.renderer.xr.getReferenceSpace();
      if (hit && referenceSpace) lockDish(view, copy, hit, referenceSpace);
      else showViewerAlert(view.blockedSurface ? copy.wallHint : copy.missHint);
    }
    stickDish(view, frame);
    try {
      prepareOcclusion(view, frame);
    } catch (error) {
      view.occlusionFailed = true;
      if (view.occluder) view.occluder.visible = false;
      console.warn("Oclusión desactivada", error);
    }
  } catch (error) {
    console.warn("Frame AR", error);
  }
  view.renderer.render(view.scene, view.camera);
}

function beginScan() {
  const view = active;
  if (!view || view.session || view.starting || !view.arReady) return;
  const copy = UI[view.menu];
  const overlay = app.querySelector(".viewer-overlay");
  view.starting = true;
  view.model.rotation.y = 0;
  let pending;
  try {
    const sessionInit = {
      requiredFeatures: ["hit-test"],
      optionalFeatures: ["dom-overlay", "depth-sensing", "anchors"],
      depthSensing: {
        usagePreference: ["gpu-optimized", "cpu-optimized"],
        dataFormatPreference: ["luminance-alpha", "float32"],
      },
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
    hideDepthFromRenderer(session);
    session.addEventListener("end", () => finishSession(view));
    cancelAnimationFrame(view.frame);
    view.studio = false;
    view.dishPlaced = false;
    view.placed.visible = false;
    view.reticle.visible = false;
    view.surfaceSeen = false;
    view.surfaceValid = false;
    view.blockedSurface = false;
    view.placeRequested = false;
    view.placing = false;
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
      tryPlaceDish(view);
    };
    view.overlay = overlay;
    overlay?.addEventListener("pointerdown", view.onPlacePointer);
    session.addEventListener("select", () => {
      if (view.suppressPlace || performance.now() - view.lastPointerAt < 400) {
        view.suppressPlace = false;
        return;
      }
      tryPlaceDish(view);
    });

    const scan = app.querySelector(".viewer-scan");
    if (scan) scan.hidden = true;
    setViewerHint(copy.scanHint);
    view.renderer.setAnimationLoop((time, frame) => drawXR(view, copy, frame));
  }).catch((error) => {
    const session = view.session;
    view.starting = false;
    view.session = null;
    session?.end().catch(() => {});
    if (active !== view) return;
    showViewerAlert(arErrorMessage(error, copy));
  });
}

function setupThree(canvas, dishId, session) {
  const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
  renderer.setClearColor(0x000000, 0);
  if (THREE.SRGBColorSpace) renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 40);
  camera.position.set(0.15, 2.15, 6.4);
  camera.lookAt(0, 0.18, 0);

  scene.add(new THREE.HemisphereLight(0xfff6ea, 0x2a211c, 2.2));
  const key = new THREE.DirectionalLight(0xffffff, 2.6);
  key.position.set(2.4, 4.2, 2.2);
  scene.add(key);
  const fill = new THREE.DirectionalLight(0xffc9a0, 0.7);
  fill.position.set(-2.8, 1.4, -1.6);
  scene.add(fill);

  const model = createDishModel(dishId);
  model.scale.setScalar(0.36);

  const shadow = new THREE.Mesh(
    new THREE.CircleGeometry(0.48, 40),
    new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.28, depthWrite: false })
  );
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.y = 0.01;

  const placed = new THREE.Group();
  placed.add(model);
  placed.add(shadow);
  scene.add(placed);

  const ring = new THREE.RingGeometry(0.07, 0.105, 48);
  ring.rotateX(-Math.PI / 2);
  const reticle = new THREE.Mesh(
    ring,
    new THREE.MeshBasicMaterial({ color: RETICLE_SCAN, side: THREE.DoubleSide, depthWrite: false })
  );
  reticle.visible = false;
  reticle.renderOrder = 2;
  scene.add(reticle);

  const occluder = createOccluder();
  scene.add(occluder);
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

  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  let dragging = false;
  let lastX = 0;
  canvas.addEventListener("pointerdown", (event) => {
    dragging = true;
    lastX = event.clientX;
    canvas.setPointerCapture?.(event.pointerId);
  });
  canvas.addEventListener("pointermove", (event) => {
    if (!dragging || !view.studio) return;
    model.rotation.y += (event.clientX - lastX) * 0.012;
    lastX = event.clientX;
  });
  function onUp() {
    dragging = false;
  }
  window.addEventListener("pointerup", onUp);

  let frame = 0;
  const view = {
    renderer,
    scene,
    camera,
    model,
    shadow,
    placed,
    reticle,
    occluder,
    depthQuad,
    observer,
    onUp,
    resize,
    studio: true,
    arReady: false,
    frame: 0,
    start() {
      frame = requestAnimationFrame(tick);
      view.frame = frame;
    },
  };

  const depthTexture = depthQuad.userData.depthTexture;
  depthQuad.onBeforeRender = (activeRenderer) => {
    const info = view.gpuDepth;
    if (!info?.texture) return;
    const props = activeRenderer.properties.get(depthTexture);
    props.__webglTexture = info.texture;
    props.__version = depthTexture.version;
    const gl = activeRenderer.getContext();
    const vp = gl.getParameter(gl.VIEWPORT);
    const uniforms = depthQuad.material.uniforms;
    uniforms.uViewport.value.set(vp[0], vp[1], Math.max(vp[2], 1), Math.max(vp[3], 1));
    const mapping = info.normDepthBufferFromNormView?.matrix;
    if (mapping) uniforms.uViewToDepth.value.fromArray(mapping);
    else uniforms.uViewToDepth.value.identity();
  };

  function tick() {
    if (generation !== session || !view.studio) return;
    if (!dragging && !reduceMotion) model.rotation.y += 0.005;
    renderer.render(scene, camera);
    frame = requestAnimationFrame(tick);
    view.frame = frame;
  }

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
  sync();
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

  if (active?.session && event.target.closest(".viewer-back, .viewer-card, .viewer-scan, .viewer-order")) {
    active.suppressPlace = true;
  }

  const action = event.target.closest("[data-action]");
  if (action?.dataset.action === "copy-slug") copySlug(action);
  if (action?.dataset.action === "start-ar") beginScan();
  if (action?.dataset.action === "add-dish") {
    const { menu, dish } = action.dataset;
    const qty = addToCart(menu, dish);
    paintAddButton(action, qty);
    showToast(UI[menu].addedToast);
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
    clearCartForMenu(action.dataset.menu);
    app.innerHTML = pedidoPlacedView(action.dataset.menu);
    window.scrollTo(0, 0);
    return;
  }
}

app.addEventListener("click", onClick);
window.addEventListener("popstate", render);
window.addEventListener("pagehide", stopViewer);
render();
