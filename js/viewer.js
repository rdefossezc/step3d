// Vue 3D des marqueurs (Three.js). Repère de la scène : X et Z au sol, Y vertical.
import * as THREE from "three";

export const COULEURS = { G: 0x4cc2ec, D: 0xf08a3c, bassin: 0xaeb8c6 };
const FOND = 0x0a0e1c;

// Convertit un point données (x, y, z, axe vertical) en coordonnées Three (Y vertical)
function versThree(x, y, z, axeVertical) {
  if (axeVertical === "y") return [x, y, -z];
  return [x, z, -y]; // axe_vertical "z" (cas des fichiers du TP)
}

function estPasCapte(x, y, z) {
  return x === 0 && y === 0 && z === 0; // (0,0,0) = marqueur non capté
}

// codes physiques des touches Z Q S D (AZERTY)
const CODES_MOUVEMENT = new Set(["KeyW", "KeyA", "KeyS", "KeyD"]);

export class Viewer {
  constructor(container) {
    this.container = container;
    this.nbImages = 0;
    this.noms = [];
    this.donnees = {};      // nom -> Float32Array(nb*3) en coordonnées Three
    this.cat = {};          // nom -> 'G' | 'D' | 'bassin'
    this.axeVertical = "z";

    this.cible = new THREE.Vector3(0, 0.9, 0);
    this.yaw = 1.2;
    this.pitch = 0.42;
    this.dist = 5;
    this.touchesMouvement = new Set();

    this._initScene();
    this._initSouris();
    this._boucle();
    new ResizeObserver(() => this._redimensionner()).observe(container);
  }

  /* ---------- scène ---------- */
  _initScene() {
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(FOND);
    this.scene.fog = new THREE.Fog(FOND, 7, 20);

    this.camera = new THREE.PerspectiveCamera(50, 1, 0.05, 100);

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.container.appendChild(this.renderer.domElement);

    this.scene.add(new THREE.AmbientLight(0xffffff, 0.75));
    const lum = new THREE.DirectionalLight(0xffffff, 1.4);
    lum.position.set(2, 4, 1);
    this.scene.add(lum);

    // sol : disque sombre sous le sujet + grille qui s'estompe dans le brouillard
    const disque = new THREE.Mesh(
      new THREE.CircleGeometry(2.7, 64),
      new THREE.MeshBasicMaterial({ color: 0x0d1428 })
    );
    disque.rotation.x = -Math.PI / 2;
    this.scene.add(disque);
    const grille = new THREE.GridHelper(24, 60, 0x26314e, 0x18203a);
    grille.position.y = 0.002;
    this.scene.add(grille);

    // groupes remplis à chaque essai
    this.groupeMarqueurs = new THREE.Group();
    this.groupeTraces = new THREE.Group();
    this.scene.add(this.groupeMarqueurs, this.groupeTraces);

    this._geoPetite = new THREE.SphereGeometry(0.02, 20, 14);
    this._geoGrande = new THREE.SphereGeometry(0.027, 20, 14);
    this._mats = {};
    for (const [k, c] of Object.entries(COULEURS)) {
      this._mats[k] = new THREE.MeshStandardMaterial({
        color: c, roughness: 0.35, metalness: 0.1,
        emissive: c, emissiveIntensity: 0.25,
      });
    }
  }

  /* ---------- souris : pivoter (glisser) et zoomer (molette) ---------- */
  _initSouris() {
    const el = this.renderer.domElement;
    let actif = false, dernierX = 0, dernierY = 0;
    el.addEventListener("mousedown", (e) => {
      if (e.button === 0) { actif = true; dernierX = e.clientX; dernierY = e.clientY; }
    });
    window.addEventListener("mouseup", () => { actif = false; });
    window.addEventListener("mousemove", (e) => {
      if (!actif) return;
      this.yaw -= (e.clientX - dernierX) * 0.005;
      this.pitch = Math.min(1.45, Math.max(0.05, this.pitch + (e.clientY - dernierY) * 0.004));
      dernierX = e.clientX; dernierY = e.clientY;
    });
    el.addEventListener("wheel", (e) => {
      e.preventDefault();
      this.dist = Math.min(20, Math.max(0.6, this.dist * Math.exp(e.deltaY * 0.001)));
    }, { passive: false });
    // touches Z Q S D (codes physiques : KeyW = Z sur AZERTY, KeyA = Q, etc.)
    window.addEventListener("keydown", (e) => { if (CODES_MOUVEMENT.has(e.code)) this.touchesMouvement.add(e.code); });
    window.addEventListener("keyup", (e) => this.touchesMouvement.delete(e.code));
    window.addEventListener("blur", () => this.touchesMouvement.clear());
  }

  /* ---------- boucle de rendu ---------- */
  _boucle() {
    const raf = (t) => {
      const dt = Math.min(0.1, (t - (this._precedent || t)) / 1000);
      this._precedent = t;
      if (this.onTick) this.onTick(dt);   // lecture image par image (gérée par l'app)
      this._deplacerCamera(dt);
      this.camera.position.set(
        this.cible.x + this.dist * Math.cos(this.pitch) * Math.cos(this.yaw),
        this.cible.y + this.dist * Math.sin(this.pitch),
        this.cible.z + this.dist * Math.cos(this.pitch) * Math.sin(this.yaw)
      );
      this.camera.lookAt(this.cible);
      this.renderer.render(this.scene, this.camera);
      requestAnimationFrame(raf);
    };
    requestAnimationFrame(raf);
  }

  _deplacerCamera(dt) {
    if (!this.touchesMouvement.size) return;
    const vitesse = this.dist * 0.35 * dt;  // proportionnel au zoom, assez lent pour viser
    const avant = new THREE.Vector3(-Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    const cote = new THREE.Vector3(avant.z, 0, -avant.x);
    const dep = new THREE.Vector3();
    if (this.touchesMouvement.has("KeyW")) dep.add(avant);  // Z : avancer
    if (this.touchesMouvement.has("KeyS")) dep.sub(avant);  // S : reculer
    if (this.touchesMouvement.has("KeyA")) dep.add(cote);   // Q : à gauche
    if (this.touchesMouvement.has("KeyD")) dep.sub(cote);   // D : à droite
    if (dep.lengthSq() > 0) {
      dep.normalize().multiplyScalar(vitesse);
      this.cible.x = Math.min(15, Math.max(-15, this.cible.x + dep.x));
      this.cible.z = Math.min(15, Math.max(-15, this.cible.z + dep.z));
    }
  }

  _redimensionner() {
    const w = this.container.clientWidth, h = this.container.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  /* ---------- chargement d'un essai ---------- */
  charger(donneesEssai) {
    this.axeVertical = donneesEssai.axeVertical;
    this.nbImages = donneesEssai.nbImages;
    this.noms = donneesEssai.noms;
    this.donnees = {};
    this.cat = {};
    for (const nom of this.noms) {
      const src = donneesEssai.positions.get(nom);
      const nb = donneesEssai.nbImages;
      const arr = new Float32Array(nb * 3);
      for (let f = 0; f < nb; f++) {
        const [x, y, z] = versThree(src[f * 3], src[f * 3 + 1], src[f * 3 + 2], this.axeVertical);
        arr[f * 3] = x; arr[f * 3 + 1] = y; arr[f * 3 + 2] = z;
      }
      this.donnees[nom] = arr;
      this.cat[nom] = nom.endsWith("_IAS") || nom.endsWith("_IPS") ? "bassin"
        : nom.startsWith("L_") ? "G" : "D";
    }
    this._construireMarqueurs();
    this._construireTraces();
    this._recentrerCamera(donneesEssai);
    this.setFrame(0);
  }

  _construireMarqueurs() {
    this._vider(this.groupeMarqueurs);
    this.meshes = new Map();
    for (const nom of this.noms) {
      const c = this.cat[nom];
      const mesh = new THREE.Mesh(
        c === "bassin" ? this._geoGrande : this._geoPetite,
        this._mats[c]
      );
      mesh.visible = false;
      this.groupeMarqueurs.add(mesh);
      this.meshes.set(nom, mesh);
    }
    // petits traits : cadre du bassin + talon-orteils
    const matTraitBassin = new THREE.LineBasicMaterial({ color: 0x93a1b8, transparent: true, opacity: 0.4 });
    this.lignes = [];
    const nomsBassin = this.noms.filter((n) => this.cat[n] === "bassin");
    if (nomsBassin.length >= 3) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(nomsBassin.length * 3), 3));
      const boucle = new THREE.LineLoop(geo, matTraitBassin);
      boucle.frustumCulled = false;
      this.groupeMarqueurs.add(boucle);
      this.lignes.push({ obj: boucle, noms: nomsBassin });
    }
    const matTraitsPied = (pied) => new THREE.LineBasicMaterial({
      color: COULEURS[pied], transparent: true, opacity: 0.55,
    });
    for (const pied of ["G", "D"]) {
      const talon = this.noms.find((n) => n === (pied === "G" ? "L_FCC" : "R_FCC"));
      if (!talon) continue;
      for (const orteil of ["FM1", "FM5"]) {
        const nomOrteil = this.noms.find((n) => n === (pied === "G" ? "L_" : "R_") + orteil);
        if (!nomOrteil) continue;
        const geo = new THREE.BufferGeometry();
        geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(6), 3));
        const ligne = new THREE.Line(geo, matTraitsPied(pied));
        ligne.frustumCulled = false;
        this.groupeMarqueurs.add(ligne);
        this.lignes.push({ obj: ligne, noms: [talon, nomOrteil] });
      }
    }
  }

  _construireTraces() {
    // trajectoires complètes du talon et de l'orteil (FM1), en pointillés discrets
    this._vider(this.groupeTraces);
    for (const pied of ["G", "D"]) {
      for (const suffixe of ["FCC", "FM1"]) {
        const nom = this.noms.find((n) => n === (pied === "G" ? "L_" : "R_") + suffixe);
        if (!nom) continue;
        const arr = this.donnees[nom];
        const pts = [];
        for (let f = 0; f < this.nbImages - 1; f++) {
          const a = f * 3, b = (f + 1) * 3;
          if (estPasCapte(arr[a], arr[a + 1], arr[a + 2])) continue;
          if (estPasCapte(arr[b], arr[b + 1], arr[b + 2])) continue;
          pts.push(arr[a], arr[a + 1], arr[a + 2], arr[b], arr[b + 1], arr[b + 2]);
        }
        if (!pts.length) continue;
        const geo = new THREE.BufferGeometry();
        geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(pts), 3));
        const ligne = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({
          color: COULEURS[pied], transparent: true, opacity: 0.28,
        }));
        this.groupeTraces.add(ligne);
      }
    }
  }

  _recentrerCamera(donneesEssai) {
    // cadre la vue sur le trajet parcouru
    let minX = 1e9, maxX = -1e9, minZ = 1e9, maxZ = -1e9, maxY = 0;
    for (const nom of this.noms) {
      const arr = this.donnees[nom];
      for (let f = 0; f < this.nbImages; f += 12) {
        const x = arr[f * 3], y = arr[f * 3 + 1], z = arr[f * 3 + 2];
        if (estPasCapte(x, y, z)) continue;
        minX = Math.min(minX, x); maxX = Math.max(maxX, x);
        minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
        maxY = Math.max(maxY, y);
      }
    }
    if (minX > maxX) { minX = maxX = minZ = maxZ = 0; maxY = 1; }
    this.cible.set((minX + maxX) / 2, Math.max(0.85, maxY * 0.6), (minZ + maxZ) / 2);
    this.dist = Math.min(9, Math.max(3.2, Math.max(maxX - minX, maxZ - minZ) * 1.15 + 1.5));
    this.pitch = 0.45;
    // oriente la vue de biais par rapport au sens de la marche
    const prem = this._centroidBassin(0), dern = this._centroidBassin(this.nbImages - 1);
    if (prem && dern) {
      this.yaw = Math.atan2(dern.z - prem.z, dern.x - prem.x) + 2.4;
    } else {
      this.yaw = 1.2;
    }
  }

  _centroidBassin(f) {
    const nomsBassin = this.noms.filter((n) => this.cat[n] === "bassin");
    let x = 0, y = 0, z = 0, n = 0;
    for (const nom of nomsBassin) {
      const arr = this.donnees[nom];
      const px = arr[f * 3], py = arr[f * 3 + 1], pz = arr[f * 3 + 2];
      if (estPasCapte(px, py, pz)) continue;
      x += px; y += py; z += pz; n++;
    }
    return n ? { x: x / n, y: y / n, z: z / n } : null;
  }

  /* ---------- mise à jour d'une image ---------- */
  setFrame(f) {
    this.frame = f;
    const courant = {};
    for (const nom of this.noms) {
      const arr = this.donnees[nom];
      const x = arr[f * 3], y = arr[f * 3 + 1], z = arr[f * 3 + 2];
      const mesh = this.meshes.get(nom);
      if (estPasCapte(x, y, z)) {
        mesh.visible = false;
      } else {
        mesh.visible = true;
        mesh.position.set(x, y, z);
        courant[nom] = [x, y, z];
      }
    }
    for (const { obj, noms: lst } of this.lignes) {
      const pos = obj.geometry.getAttribute("position");
      let ok = lst.every((n) => courant[n]);
      if (ok) {
        lst.forEach((n, i) => pos.setXYZ(i, ...courant[n]));
        pos.needsUpdate = true;
        obj.visible = true;
      } else {
        obj.visible = false;
      }
    }
  }

  _vider(groupe) {
    for (const enfant of [...groupe.children]) groupe.remove(enfant);
  }
}
