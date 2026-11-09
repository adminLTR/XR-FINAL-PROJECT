import * as THREE from "https://cdn.jsdelivr.net/npm/three@0.170.0/build/three.module.js";
import { MENUS, UI, findDish, dishCount } from "./menus.js";
import { createDishModel } from "./models.js";

const app = document.querySelector("#app");

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
  cancelSource(current.transientSource);
  current.hitTestSource = null;
  current.transientSource = null;
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

function setDishScale(view, scale) {
  view.model.scale.setScalar(scale);
  const shadowScale = scale / 0.36;
  view.shadow.scale.set(shadowScale, shadowScale, shadowScale);
}

function showStudio(view) {
  view.studio = true;
  view.surfaceSeen = false;
  view.placed.matrixAutoUpdate = true;
  view.placed.position.set(0, 0, 0);
  view.placed.rotation.set(0, 0, 0);
  view.placed.scale.set(1, 1, 1);
  view.placed.visible = true;
  setDishScale(view, 0.36);
  view.reticle.visible = false;
  view.camera.position.set(0.15, 2.15, 6.4);
  view.camera.lookAt(0, 0.18, 0);
  view.resize();
}

function putDish(view, matrix) {
  setDishScale(view, 0.12);
  view.placed.matrixAutoUpdate = false;
  view.placed.matrix.fromArray(matrix);
  view.placed.visible = true;
}

function finishSession(view) {
  cancelSource(view.hitTestSource);
  cancelSource(view.transientSource);
  view.hitTestSource = null;
  view.transientSource = null;
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

function drawXR(view, copy, frame) {
  if (!frame || active !== view) return;
  const refSpace = view.renderer.xr.getReferenceSpace();
  if (!refSpace) return;

  view.reticle.visible = false;
  if (view.hitTestSource) {
    const hits = frame.getHitTestResults(view.hitTestSource);
    const pose = hits[0]?.getPose(refSpace);
    if (pose && isHorizontalSurface(pose.transform.matrix)) {
      view.reticle.visible = true;
      view.reticle.matrix.fromArray(pose.transform.matrix);
      if (!view.surfaceSeen) {
        view.surfaceSeen = true;
        setViewerHint(copy.placeHint);
      }
    }
  }

  if (view.suppressPlace) {
    view.suppressPlace = false;
  } else if (view.transientSource) {
    const inputs = frame.getHitTestResultsForTransientInput(view.transientSource);
    for (const input of inputs) {
      const pose = input.results?.[0]?.getPose(refSpace);
      if (!pose) {
        showViewerAlert(copy.missHint);
        continue;
      }
      if (!isHorizontalSurface(pose.transform.matrix)) {
        showViewerAlert(copy.wallHint);
        continue;
      }
      putDish(view, pose.transform.matrix);
      setViewerHint(copy.placedHint);
    }
  } else if (view.placeAtReticle) {
    view.placeAtReticle = false;
    if (view.reticle.visible) {
      putDish(view, view.reticle.matrix.elements);
      setViewerHint(copy.placedHint);
    } else {
      showViewerAlert(copy.missHint);
    }
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
    pending = navigator.xr.requestSession("immersive-ar", {
      requiredFeatures: ["local", "hit-test"],
      optionalFeatures: ["dom-overlay"],
      domOverlay: overlay ? { root: overlay } : undefined,
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
    session.addEventListener("end", () => finishSession(view));
    cancelAnimationFrame(view.frame);
    view.studio = false;
    view.placed.visible = false;
    view.reticle.visible = false;
    view.surfaceSeen = false;
    view.renderer.xr.enabled = true;
    view.renderer.xr.setReferenceSpaceType("local");
    await view.renderer.xr.setSession(session);
    if (active !== view) return;

    const viewerSpace = await session.requestReferenceSpace("viewer");
    view.hitTestSource = await session.requestHitTestSource({ space: viewerSpace });
    try {
      view.transientSource = await session.requestHitTestSourceForTransientInput({
        profile: "generic-touchscreen",
      });
    } catch {
      view.transientSource = null;
      session.addEventListener("select", () => {
        view.placeAtReticle = true;
      });
    }
    if (active !== view) return;

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

  const ring = new THREE.RingGeometry(0.075, 0.1, 48);
  ring.rotateX(-Math.PI / 2);
  const reticle = new THREE.Mesh(
    ring,
    new THREE.MeshBasicMaterial({ color: 0xf0c27a, side: THREE.DoubleSide, depthWrite: false })
  );
  reticle.matrixAutoUpdate = false;
  reticle.visible = false;
  scene.add(reticle);

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
