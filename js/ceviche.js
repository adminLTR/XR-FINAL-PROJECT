import * as THREE from "three";
import { CEVICHE_PARTS, ingredientLabel } from "./models.js";

const ORIGIN = new THREE.Vector3(0, 0.2, 0);
const OPEN_MS = 0.86;
const LEAVE_MS = 0.4;
const SNAP_MS = 0.28;
const PULL_AWAY = 0.32;

const _raycaster = new THREE.Raycaster();
const _ndc = new THREE.Vector2();
const _hit = new THREE.Vector3();
const _cam = new THREE.Vector3();
const _plane = new THREE.Plane();
const _forward = new THREE.Vector2();
const _right = new THREE.Vector2();

function smooth(value) {
  const t = Math.min(Math.max(value, 0), 1);
  return t * t * (3 - 2 * t);
}

export function orderedOmit(ids) {
  const picked = new Set(ids || []);
  return CEVICHE_PARTS.map((part) => part.id).filter((id) => picked.has(id));
}

export function omitKey(ids) {
  return orderedOmit(ids).join("|");
}

export function omitNote(ids, lang) {
  const names = orderedOmit(ids).map((id) => ingredientLabel(id, lang).toLowerCase());
  if (!names.length) return "";
  const prefix = lang === "pt" ? "Sem " : "Sin ";
  if (names.length === 1) return prefix + names[0];
  const last = names[names.length - 1];
  const conj = lang === "pt" ? " e " : " y ";
  return prefix + names.slice(0, -1).join(", ") + conj + last;
}

function labelSprite(text) {
  const canvas = document.createElement("canvas");
  canvas.width = 512;
  canvas.height = 160;
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, 512, 160);
  ctx.fillStyle = "rgba(22, 16, 12, 0.82)";
  ctx.fillRect(24, 36, 464, 88);
  ctx.fillStyle = "#f6efe4";
  ctx.font = "600 64px Arial, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, 256, 80);
  const map = new THREE.CanvasTexture(canvas);
  if (THREE.SRGBColorSpace) map.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
    map,
    transparent: true,
    depthWrite: false,
  }));
  sprite.name = "ingredient-label";
  sprite.position.y = 0.38;
  sprite.scale.set(0.52, 0.162, 1);
  return sprite;
}

function ensureLabels(asm, lang) {
  if (asm.labelLang === lang) return;
  for (const piece of asm.pieces) {
    const previous = piece.node.getObjectByName("ingredient-label");
    if (previous) {
      previous.material.map?.dispose();
      previous.material.dispose();
      previous.removeFromParent();
    }
    piece.node.add(labelSprite(ingredientLabel(piece.id, lang)));
  }
  asm.labelLang = lang;
}

export function attachCeviche(placed, model) {
  const food = model.getObjectByName("ceviche-food");
  const holder = model.getObjectByName("ceviche-parts");
  const plate = model.getObjectByName("empty-plate");
  if (!food || !holder) return;
  const pieces = [...holder.children]
    .filter((node) => node.userData?.ingredientId)
    .map((node) => ({
      id: node.userData.ingredientId,
      node,
      from: new THREE.Vector3(),
      to: new THREE.Vector3(),
      nest: new THREE.Vector3(),
      float: new THREE.Vector3(),
      scaleFrom: 1,
      scaleTo: 1,
      leaving: false,
      snap: false,
    }));
  placed.userData.assembly = {
    phase: "closed",
    mode: "full",
    t: 0,
    omit: new Set(),
    food,
    plate,
    model,
    pieces,
    labelLang: "",
    restoreFull: true,
  };
}

function alive(asm) {
  return asm.pieces.filter((piece) => !asm.omit.has(piece.id));
}

function layoutFloat(asm, camera) {
  camera.updateMatrixWorld(true);
  asm.model.updateWorldMatrix(true, false);
  _cam.copy(camera.getWorldPosition(_cam));
  asm.model.worldToLocal(_cam);
  _forward.set(_cam.x, _cam.z);
  if (_forward.lengthSq() < 1e-6) _forward.set(0, 1);
  _forward.normalize();
  _right.set(_forward.y, -_forward.x);
  const pieces = alive(asm);
  const count = pieces.length;
  const radius = 0.34;
  const spread = Math.PI;
  pieces.forEach((piece, index) => {
    const t = count === 1 ? 0.5 : index / (count - 1);
    const angle = -spread / 2 + t * spread;
    const bow = Math.cos(angle);
    const lateral = Math.sin(angle) * radius;
    const along = radius * 0.42 - bow * radius;
    piece.float.set(
      _right.x * lateral + _forward.x * along,
      0.3 + bow * 0.16,
      _right.y * lateral + _forward.y * along,
    );
  });
}

function pose(asm, amount) {
  const eased = smooth(amount);
  asm.food.scale.setScalar(asm.foodFrom + (asm.foodTo - asm.foodFrom) * eased);
  for (const piece of asm.pieces) {
    if (asm.omit.has(piece.id) || piece.leaving || !piece.node.visible) continue;
    piece.node.position.lerpVectors(piece.from, piece.to, eased);
    const scale = piece.scaleFrom + (piece.scaleTo - piece.scaleFrom) * eased;
    piece.node.scale.setScalar(scale);
  }
}

function startOpen(asm, camera, lang) {
  ensureLabels(asm, lang);
  layoutFloat(asm, camera);
  const fromPlate = asm.mode === "full";
  for (const piece of asm.pieces) {
    piece.snap = false;
    piece.leaving = false;
    if (asm.omit.has(piece.id)) {
      piece.node.visible = false;
      continue;
    }
    piece.from.copy(fromPlate ? ORIGIN : piece.node.position);
    piece.to.copy(piece.float);
    piece.scaleFrom = fromPlate ? 0.2 : piece.node.scale.x;
    piece.scaleTo = 0.62;
    piece.node.visible = true;
    if (fromPlate) {
      piece.node.position.copy(ORIGIN);
      piece.node.scale.setScalar(0.2);
    }
  }
  asm.food.visible = false;
  asm.food.scale.setScalar(1);
  asm.foodFrom = 1;
  asm.foodTo = 1;
  if (asm.plate) asm.plate.visible = true;
  asm.phase = "opening";
  asm.t = 0;
}

function finishOpen(asm) {
  asm.phase = "open";
  asm.mode = "parts";
  asm.food.visible = false;
  asm.food.scale.setScalar(1);
  if (asm.plate) asm.plate.visible = true;
  for (const piece of alive(asm)) {
    piece.node.visible = true;
    piece.node.position.copy(piece.float);
    piece.node.scale.setScalar(0.62);
  }
}

function startClose(asm) {
  for (const piece of asm.pieces) {
    piece.snap = false;
    piece.leaving = false;
    piece.node.visible = false;
  }
  if (asm.plate) asm.plate.visible = false;
  asm.restoreFull = true;
  asm.food.visible = true;
  asm.food.scale.setScalar(1);
  asm.foodFrom = 1;
  asm.foodTo = 1;
  asm.phase = "closed";
  asm.mode = "full";
  asm.t = 1;
}

function finishClose(asm) {
  startClose(asm);
}

export function closeCevicheIfOpen(group) {
  const asm = group?.userData.assembly;
  if (!asm || asm.phase === "closed" || asm.phase === "closing") return;
  if (asm.phase === "opening") asm.phase = "open";
  startClose(asm);
}

export function toggleCeviche(group, camera, lang) {
  const asm = group?.userData.assembly;
  if (!asm?.pieces.length || !group.visible) return null;
  if (asm.phase === "opening" || asm.phase === "closing") return null;
  if (asm.phase === "open") {
    startClose(asm);
    return "closed";
  }
  startOpen(asm, camera, lang);
  return "open";
}

export function tickCeviche(groups, dt) {
  const step = Math.min(Math.max(dt, 0), 0.05);
  for (const group of groups) {
    const asm = group.userData.assembly;
    if (!asm) continue;
    if (asm.phase === "opening" || asm.phase === "closing") {
      asm.t += step / OPEN_MS;
      pose(asm, Math.min(asm.t, 1));
      if (asm.t >= 1) {
        if (asm.phase === "opening") finishOpen(asm);
        else finishClose(asm);
      }
    }
    for (const piece of asm.pieces) {
      if (piece.leaving) {
        piece.leaveT += step / LEAVE_MS;
        const amount = Math.min(piece.leaveT, 1);
        piece.node.position.copy(piece.leaveFrom).addScaledVector(piece.leaveDir, amount * 0.9);
        piece.node.position.y += amount * 0.16;
        piece.node.scale.setScalar(Math.max(0.001, 1 - amount));
        if (amount >= 1) {
          piece.leaving = false;
          piece.node.visible = false;
        }
        continue;
      }
      if (piece.snap && asm.phase === "open") {
        piece.snapT += step / SNAP_MS;
        const amount = smooth(Math.min(piece.snapT, 1));
        piece.node.position.lerpVectors(piece.snapFrom, piece.float, amount);
        if (piece.snapT >= 1) piece.snap = false;
      }
    }
  }
}

function rayFrom(view, event) {
  const cam = view.renderer.xr.getCamera();
  const camera = cam.cameras?.[0] || cam;
  const width = window.innerWidth || 1;
  const height = window.innerHeight || 1;
  _ndc.set((event.clientX / width) * 2 - 1, -(event.clientY / height) * 2 + 1);
  camera.updateMatrixWorld(true);
  _raycaster.setFromCamera(_ndc, camera);
  return _raycaster;
}

function pieceFromObject(object) {
  let node = object;
  while (node) {
    if (node.userData?.ingredientId) return node;
    node = node.parent;
  }
  return null;
}

function hostOf(node) {
  let current = node;
  while (current) {
    if (current.userData?.assembly) return current;
    current = current.parent;
  }
  return null;
}

export function beginCevicheDrag(view, event, groups) {
  if (!view.session) return null;
  const nodes = [];
  for (const group of groups) {
    const asm = group.userData.assembly;
    if (!asm || asm.phase !== "open") continue;
    for (const piece of asm.pieces) {
      if (!piece.leaving && piece.node.visible && !asm.omit.has(piece.id)) nodes.push(piece.node);
    }
  }
  if (!nodes.length) return null;
  const hits = rayFrom(view, event).intersectObjects(nodes, true);
  const node = hits.length ? pieceFromObject(hits[0].object) : null;
  if (!node) return null;
  const group = hostOf(node);
  const piece = group?.userData.assembly.pieces.find((item) => item.node === node);
  if (!group || !piece) return null;
  piece.snap = false;
  piece.node.updateWorldMatrix(true, false);
  view.ingredientDrag = {
    pointerId: event.pointerId,
    piece,
    group,
    planeWorldY: piece.node.getWorldPosition(_hit).y,
    startX: event.clientX,
    startY: event.clientY,
    moved: false,
  };
  return group;
}

export function moveCevicheDrag(view, event) {
  const drag = view.ingredientDrag;
  if (!drag || drag.pointerId !== event.pointerId) return false;
  if (!drag.moved && Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < 8) return true;
  drag.moved = true;
  _plane.setFromNormalAndCoplanarPoint(
    _hit.set(0, 1, 0),
    _cam.set(0, drag.planeWorldY, 0),
  );
  if (!rayFrom(view, event).ray.intersectPlane(_plane, _hit)) return true;
  const parent = drag.piece.node.parent;
  parent?.updateWorldMatrix(true, false);
  parent?.worldToLocal(_hit);
  _hit.y += 0.08;
  drag.piece.node.position.copy(_hit);
  return true;
}

function discardPiece(asm, piece) {
  asm.omit.add(piece.id);
  piece.leaving = true;
  piece.snap = false;
  piece.leaveT = 0;
  piece.leaveFrom = piece.node.position.clone();
  piece.leaveDir = piece.node.position.clone().sub(piece.float);
  if (piece.leaveDir.lengthSq() < 1e-4) piece.leaveDir.set(0, 0.15, 0.8);
  piece.leaveDir.normalize();
}

export function releaseCevicheDrag(view, { cancel = false } = {}) {
  const drag = view.ingredientDrag;
  if (!drag) return null;
  view.ingredientDrag = null;
  const piece = drag.piece;
  const asm = drag.group.userData.assembly;
  const pulled = drag.moved && piece.node.position.distanceTo(piece.float) > PULL_AWAY;
  if (!cancel && pulled && asm?.phase === "open") {
    discardPiece(asm, piece);
    return { group: drag.group, removed: true };
  }
  if (drag.moved) {
    piece.snap = true;
    piece.snapT = 0;
    piece.snapFrom = piece.node.position.clone();
  }
  return { group: drag.group, removed: false };
}

export function endCevicheDrag(view, event) {
  const drag = view.ingredientDrag;
  if (!drag || drag.pointerId !== event.pointerId) return null;
  return releaseCevicheDrag(view);
}

export function cancelCevicheDrag(view) {
  return releaseCevicheDrag(view, { cancel: true });
}
