import * as THREE from "https://cdn.jsdelivr.net/npm/three@0.170.0/build/three.module.js";

const materials = new Map();

function material(color, roughness = 0.62) {
  const key = `${color}-${roughness}`;
  if (!materials.has(key)) {
    materials.set(key, new THREE.MeshStandardMaterial({ color, roughness, metalness: 0.03 }));
  }
  return materials.get(key);
}

function put(group, geometry, color, x, y, z, sx = 1, sy = 1, sz = 1, rx = 0, ry = 0, rz = 0) {
  const mesh = new THREE.Mesh(geometry, material(color));
  mesh.position.set(x, y, z);
  mesh.scale.set(sx, sy, sz);
  mesh.rotation.set(rx, ry, rz);
  group.add(mesh);
  return mesh;
}

const sphere = new THREE.SphereGeometry(1, 28, 18);
const box = new THREE.BoxGeometry(1, 1, 1);
const cyl = new THREE.CylinderGeometry(1, 1, 1, 28);
const cone = new THREE.ConeGeometry(1, 1, 24);
const torus = new THREE.TorusGeometry(1, 0.22, 8, 18);
const rim = new THREE.TorusGeometry(1.16, 0.04, 8, 48);

function plate() {
  const group = new THREE.Group();
  put(group, cyl, 0xf7f1e6, 0, 0.04, 0, 1.16, 0.06, 1.16);
  put(group, rim, 0xe7dccb, 0, 0.07, 0, 1, 1, 1, Math.PI / 2, 0, 0);
  return group;
}

function rice(group, color, x, y, z, scale = 1) {
  put(group, sphere, color, x, y, z, 0.46 * scale, 0.28 * scale, 0.42 * scale);
}

function lime(group, x, y, z) {
  put(group, sphere, 0x8fbf3f, x, y, z, 0.16, 0.16, 0.16);
}

function olive(group, x, y, z) {
  put(group, sphere, 0x2f3a28, x, y, z, 0.07, 0.09, 0.07);
}

function egg(group, x, y, z) {
  put(group, sphere, 0xf4f0e6, x, y, z, 0.16, 0.12, 0.16);
  put(group, sphere, 0xf0b429, x, y + 0.04, z, 0.07, 0.05, 0.07);
}

function shrimp(group, x, y, z, ry = 0) {
  put(group, torus, 0xf08a6a, x, y, z, 0.12, 0.12, 0.12, Math.PI / 2.4, ry, 0.4);
}

function glass(group, liquid, x = 0, z = 0) {
  put(group, cyl, 0xf7f4ee, x, 0.62, z, 0.26, 0.72, 0.26);
  put(group, cyl, liquid, x, 0.52, z, 0.2, 0.5, 0.2);
  put(group, torus, 0xe7e0d4, x, 0.98, z, 0.22, 0.22, 0.22, Math.PI / 2, 0, 0);
}

function fries(group, x, z) {
  for (let i = 0; i < 5; i += 1) {
    put(group, box, 0xf2c14a, x + (i - 2) * 0.06, 0.28, z, 0.05, 0.28, 0.08, 0, 0.2 * i, 0.15);
  }
}

const builders = {
  ceviche(group) {
    put(group, cyl, 0xfbfbfb, 0, 0.14, 0, 0.62, 0.1, 0.62);
    put(group, rim, 0xf4f4f4, 0, 0.2, 0, 0.5, 0.5, 0.5, Math.PI / 2, 0, 0);
    put(group, box, 0xf2c1a8, -0.12, 0.26, 0.02, 0.24, 0.08, 0.14, 0.2, 0.5, 0.1);
    put(group, box, 0xf7d2bf, 0.14, 0.28, -0.06, 0.2, 0.07, 0.12, 0.4, 1.1, 0.2);
    put(group, torus, 0x8b4d8a, 0.02, 0.3, 0.08, 0.16, 0.16, 0.16, Math.PI / 2, 0, 0);
    put(group, sphere, 0xf2d15a, -0.28, 0.24, 0.2, 0.1, 0.1, 0.1);
    lime(group, 0.36, 0.2, 0.22);
  },
  "causa-limena"(group) {
    put(group, cyl, 0xf0c14a, 0, 0.18, 0, 0.48, 0.1, 0.48);
    put(group, cyl, 0xe7d3b0, 0, 0.28, 0, 0.4, 0.08, 0.4);
    put(group, cyl, 0xf0c14a, 0, 0.38, 0, 0.48, 0.1, 0.48);
    put(group, sphere, 0x4f8f3a, -0.12, 0.5, 0.08, 0.16, 0.08, 0.18);
    egg(group, 0.16, 0.5, -0.02);
  },
  "papa-huancaina"(group) {
    put(group, cyl, 0xf0c14a, 0, 0.16, 0, 0.62, 0.08, 0.5);
    put(group, sphere, 0xe6c36a, -0.16, 0.28, 0, 0.2, 0.14, 0.16);
    put(group, sphere, 0xe6c36a, 0.14, 0.28, 0.06, 0.18, 0.13, 0.15);
    egg(group, 0.02, 0.34, -0.16);
    olive(group, 0.28, 0.24, 0.16);
  },
  anticuchos(group) {
    put(group, box, 0xd8d2c8, -0.28, 0.34, 0, 0.04, 0.04, 0.7);
    put(group, box, 0x6b3a2a, -0.28, 0.36, -0.16, 0.14, 0.12, 0.14);
    put(group, box, 0x7a4632, -0.28, 0.36, 0.02, 0.14, 0.12, 0.14);
    put(group, box, 0x5c3224, -0.28, 0.36, 0.2, 0.14, 0.12, 0.14);
    put(group, sphere, 0xe6c36a, 0.22, 0.24, -0.1, 0.16, 0.12, 0.14);
    put(group, sphere, 0xf2d15a, 0.28, 0.28, 0.18, 0.12, 0.12, 0.12);
  },
  "lomo-saltado"(group) {
    rice(group, 0xf3f0e4, -0.34, 0.28, -0.08);
    put(group, box, 0x6b3a2a, 0.05, 0.3, 0.02, 0.34, 0.08, 0.16, 0.2, 0.6, 0.2);
    put(group, box, 0x8a4a34, 0.12, 0.38, -0.08, 0.28, 0.07, 0.12, 0.4, 1.2, 0.1);
    put(group, box, 0xc6452f, -0.02, 0.36, 0.16, 0.16, 0.08, 0.12);
    put(group, torus, 0xe7dcc8, 0.2, 0.34, 0.12, 0.12, 0.12, 0.12, Math.PI / 2, 0, 0);
    fries(group, 0.28, -0.22);
  },
  "aji-de-gallina"(group) {
    put(group, cyl, 0xf0c14a, 0.08, 0.2, 0.05, 0.55, 0.12, 0.48);
    put(group, box, 0xe7d3b0, -0.05, 0.3, 0.02, 0.3, 0.04, 0.08, 0.2, 0.4, 0);
    put(group, box, 0xe7d3b0, 0.12, 0.32, -0.06, 0.24, 0.04, 0.07, 0.3, 1, 0.2);
    put(group, sphere, 0xe6c36a, -0.28, 0.24, 0.16, 0.16, 0.12, 0.14);
    rice(group, 0xf3f0e4, 0.36, 0.26, -0.18);
    egg(group, -0.18, 0.32, -0.16);
    olive(group, 0.22, 0.3, 0.18);
  },
  "arroz-con-pollo"(group) {
    rice(group, 0xb7c96a, 0, 0.32, 0, 1.35);
    put(group, sphere, 0xe7d3b0, 0.08, 0.42, 0.04, 0.28, 0.16, 0.22);
    put(group, sphere, 0xc4843a, 0.16, 0.5, 0.08, 0.1, 0.06, 0.1);
    put(group, sphere, 0x6f8f45, -0.22, 0.4, 0.12, 0.06, 0.06, 0.06);
  },
  "seco-de-res"(group) {
    rice(group, 0xf3f0e4, -0.36, 0.26, -0.05);
    put(group, cyl, 0x6f8f45, 0.12, 0.22, 0.04, 0.5, 0.16, 0.46);
    put(group, box, 0x6b3a2a, 0.02, 0.34, 0, 0.22, 0.1, 0.16);
    put(group, sphere, 0x5a3a28, 0.22, 0.32, 0.12, 0.08, 0.06, 0.08);
    put(group, sphere, 0x5a3a28, 0.16, 0.3, -0.1, 0.07, 0.05, 0.07);
  },
  "pollo-a-la-brasa"(group) {
    put(group, sphere, 0xc4843a, -0.05, 0.36, 0, 0.42, 0.28, 0.32);
    put(group, sphere, 0x8a4a2c, 0.12, 0.42, 0.08, 0.16, 0.08, 0.18);
    put(group, box, 0xd8b48a, -0.28, 0.24, 0.16, 0.08, 0.16, 0.08, 0.4, 0, 0.5);
    fries(group, 0.32, 0.02);
    put(group, sphere, 0x7dae52, 0.16, 0.22, -0.32, 0.18, 0.06, 0.14);
  },
  "suspiro-limeno"(group) {
    const glass = new THREE.Mesh(
      cyl,
      new THREE.MeshStandardMaterial({ color: 0xffffff, transparent: true, opacity: 0.28, roughness: 0.08 })
    );
    glass.position.set(0, 0.42, 0);
    glass.scale.set(0.38, 0.55, 0.38);
    group.add(glass);
    put(group, cyl, 0xc9843a, 0, 0.28, 0, 0.3, 0.22, 0.3);
    put(group, sphere, 0xfffaf2, 0, 0.62, 0, 0.34, 0.22, 0.34);
    put(group, sphere, 0x8a5a32, 0.08, 0.78, 0.04, 0.03, 0.03, 0.03);
  },
  "pao-de-queijo"(group) {
    const spots = [[-0.28, 0.08], [0, -0.02], [0.28, 0.08], [-0.14, 0.28], [0.16, 0.3], [0, 0.16]];
    spots.forEach(([x, z], index) => {
      put(group, sphere, index % 2 ? 0xf6e2b8 : 0xf0d08a, x, 0.28, z, 0.18, 0.16, 0.18);
    });
  },
  coxinha(group) {
    put(group, cone, 0xe2b15a, 0, 0.48, 0, 0.28, 0.55, 0.28);
    put(group, sphere, 0xd7a24e, 0, 0.22, 0, 0.3, 0.2, 0.3);
    put(group, sphere, 0xf2d7a2, 0, 0.28, 0.08, 0.08, 0.06, 0.06);
  },
  acaraje(group) {
    put(group, sphere, 0xe07a2f, 0, 0.28, 0, 0.55, 0.22, 0.38);
    put(group, sphere, 0xf3d7a2, 0, 0.4, 0, 0.28, 0.08, 0.2);
    shrimp(group, 0.08, 0.48, 0.04, 0.6);
    put(group, sphere, 0xf2d15a, -0.12, 0.44, 0.02, 0.08, 0.05, 0.08);
  },
  feijoada(group) {
    put(group, cyl, 0x2a211c, 0.05, 0.28, 0, 0.48, 0.28, 0.48);
    put(group, cyl, 0x1a120e, 0.05, 0.42, 0, 0.4, 0.08, 0.4);
    put(group, sphere, 0x3a2418, -0.08, 0.48, 0.04, 0.08, 0.06, 0.08);
    put(group, sphere, 0x4a2e22, 0.1, 0.48, -0.06, 0.07, 0.05, 0.07);
    rice(group, 0xf3f0e4, -0.42, 0.24, 0.08);
    put(group, box, 0x3f6b32, 0.38, 0.24, -0.12, 0.2, 0.05, 0.16, 0.2, 0.4, 0);
    put(group, sphere, 0xf08a2a, 0.34, 0.28, 0.2, 0.14, 0.08, 0.14);
  },
  moqueca(group) {
    put(group, cyl, 0xc47a4a, 0, 0.24, 0, 0.58, 0.22, 0.58);
    put(group, cyl, 0xf4e2c4, 0, 0.36, 0, 0.48, 0.08, 0.48);
    put(group, box, 0xf2c1a8, -0.08, 0.42, 0, 0.28, 0.08, 0.16, 0, 0.4, 0);
    put(group, box, 0xc6452f, 0.16, 0.42, 0.08, 0.14, 0.06, 0.1);
    put(group, box, 0xf2d15a, 0.02, 0.42, -0.14, 0.12, 0.05, 0.08);
    put(group, sphere, 0x6f8f45, 0.22, 0.4, -0.08, 0.05, 0.05, 0.05);
    rice(group, 0xf3f0e4, -0.5, 0.24, 0.2);
  },
  picanha(group) {
    put(group, box, 0x7a3b32, 0, 0.28, 0, 0.7, 0.18, 0.42);
    put(group, box, 0xf3efe4, 0, 0.4, 0, 0.7, 0.08, 0.42);
    put(group, sphere, 0xe2b15a, 0.46, 0.24, 0.16, 0.2, 0.1, 0.18);
    put(group, box, 0xc6452f, -0.42, 0.2, -0.18, 0.1, 0.08, 0.1);
    put(group, sphere, 0x6f8f45, -0.32, 0.2, -0.2, 0.06, 0.05, 0.06);
  },
  "bobo-de-camarao"(group) {
    put(group, cyl, 0xe07a2f, 0, 0.22, 0, 0.58, 0.16, 0.5);
    shrimp(group, -0.12, 0.4, 0.04, 0.2);
    shrimp(group, 0.14, 0.42, -0.02, 1.1);
    shrimp(group, 0.02, 0.4, 0.12, 2);
    put(group, sphere, 0x6f8f45, 0.24, 0.36, 0.12, 0.05, 0.05, 0.05);
    rice(group, 0xf3f0e4, -0.48, 0.24, -0.12);
  },
  "baiao-de-dois"(group) {
    rice(group, 0xe6d3a1, 0, 0.32, 0, 1.4);
    put(group, sphere, 0x6a8f3a, -0.12, 0.4, 0.04, 0.06, 0.05, 0.06);
    put(group, sphere, 0x6a8f3a, 0.1, 0.4, -0.06, 0.05, 0.04, 0.05);
    put(group, box, 0xf0d08a, 0.16, 0.42, 0.1, 0.16, 0.08, 0.12);
    put(group, box, 0x8a4a34, -0.2, 0.4, -0.08, 0.16, 0.06, 0.1);
  },
  escondidinho(group) {
    put(group, cyl, 0xd8b48a, 0, 0.2, 0, 0.62, 0.16, 0.5);
    put(group, box, 0x8a4a34, -0.08, 0.28, 0, 0.24, 0.06, 0.16);
    put(group, cyl, 0xf0d7a2, 0, 0.36, 0, 0.6, 0.1, 0.48);
    put(group, cyl, 0xc4843a, 0, 0.42, 0, 0.58, 0.03, 0.46);
    put(group, sphere, 0x6f8f45, 0.18, 0.46, 0.08, 0.04, 0.04, 0.04);
  },
  "chicha-morada"(group) {
    glass(group, 0x6a2458);
    put(group, sphere, 0xf2c14a, 0.1, 0.86, 0.04, 0.05, 0.04, 0.05);
  },
  limonada(group) {
    glass(group, 0xe7f0a8);
    lime(group, 0.22, 0.22, 0.16);
  },
  maracuya(group) {
    glass(group, 0xe08a2a);
    put(group, sphere, 0xf2c14a, -0.08, 0.84, 0.04, 0.045, 0.035, 0.045);
  },
  "inca-kola"(group) {
    put(group, cyl, 0xf6d24a, 0, 0.42, 0, 0.22, 0.5, 0.22);
    put(group, cyl, 0xf3c431, 0, 0.78, 0, 0.1, 0.22, 0.1);
    put(group, cyl, 0xe2b15a, 0, 0.94, 0, 0.12, 0.06, 0.12);
    put(group, box, 0x9d2e18, 0, 0.48, 0.2, 0.16, 0.1, 0.01);
  },
  brigadeiro(group) {
    [[-0.22, -0.08], [0.18, -0.12], [-0.08, 0.2], [0.24, 0.16]].forEach(([x, z], index) => {
      put(group, sphere, 0x4a2c22, x, 0.26, z, 0.18, 0.16, 0.18);
      put(group, sphere, index % 2 ? 0xf2d7a2 : 0xffffff, x + 0.06, 0.36, z, 0.035, 0.035, 0.035);
      put(group, sphere, 0xf2d7a2, x - 0.04, 0.34, z + 0.05, 0.03, 0.03, 0.03);
    });
  },
};

export function createDishModel(dishId) {
  const root = new THREE.Group();
  root.add(plate());
  const food = new THREE.Group();
  food.position.y = 0.08;
  const build = builders[dishId] || builders.ceviche;
  build(food);
  root.add(food);
  return root;
}
