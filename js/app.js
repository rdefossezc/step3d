// Step3D — application d'annotation de la marche
import { Viewer } from "./viewer.js";

const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
const $ = (sel) => document.querySelector(sel);

/* ---------- état global ---------- */
const state = {
  arbo: [],                 // sujets -> visites -> essais
  essai: null,              // essai sélectionné (ligne de la base)
  data: null,               // données décodées du JSON de l'essai
  events: [],               // événements de l'essai courant
  frame: 0,
  playing: false,
  speed: 1,
  undoStack: [],            // ids des événements ajoutés depuis le début de la session
};

const viewer = new Viewer($("#viewport"));

/* ---------- utilitaires ---------- */
function fmtTemps(secondes) {
  const m = Math.floor(secondes / 60);
  const s = secondes - m * 60;
  return `${String(m).padStart(2, "0")}:${s.toFixed(2).padStart(5, "0")}`;
}
function fmtS(secondes) {
  return secondes.toFixed(2).replace(".", ",") + " s";
}
function fmtDate(iso) {
  if (!iso) return "";
  const d = new Date(iso + "T12:00:00");
  return d.toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit", year: "numeric" });
}
let toastTimer = null;
function toast(msg) {
  const el = $("#toast");
  el.textContent = msg;
  el.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add("hidden"), 2200);
}

/* ---------- décodage d'un fichier d'essai ---------- */
const cacheJson = new Map();
async function chargerJson(fichier) {
  if (cacheJson.has(fichier)) return cacheJson.get(fichier);
  const rep = await fetch(`essais/${fichier}`);
  if (!rep.ok) throw new Error(`Fichier ${fichier} introuvable`);
  const brut = await rep.json();
  const nb = brut.nb_images;
  const positions = new Map();
  for (const [nom, lignes] of Object.entries(brut.marqueurs)) {
    const arr = new Float32Array(nb * 3);
    for (let f = 0; f < nb; f++) {
      const v = lignes[f];
      if (Array.isArray(v)) {          // format [x, y, z]
        arr[f * 3] = v[0] || 0;
        arr[f * 3 + 1] = v[1] || 0;
        arr[f * 3 + 2] = v[2] || 0;
      } else {                         // format "x y z"
        const parts = String(v).trim().split(/\s+/);
        arr[f * 3] = +parts[0] || 0;
        arr[f * 3 + 1] = +parts[1] || 0;
        arr[f * 3 + 2] = +parts[2] || 0;
      }
    }
    positions.set(nom, arr);
  }
  const data = {
    noms: Object.keys(brut.marqueurs),
    positions,
    nbImages: nb,
    frequence: brut.frequence_hz,
    axeVertical: brut.axe_vertical,
    unite: brut.unite,
    contactSol: {
      G: brut.contact_sol.gauche,
      D: brut.contact_sol.droit,
    },
  };
  cacheJson.set(fichier, data);
  return data;
}

/* ---------- arborescence sujets / visites / essais ---------- */
async function chargerArbo() {
  let { data, error } = await sb.from("sujets").select("*, visites(*, essais(*))");
  if (error) { toast("Erreur de chargement : " + error.message); return; }
  data.sort((a, b) => a.code.localeCompare(b.code));
  for (const s of data) {
    s.visites.sort((a, b) => a.numero - b.numero);
    for (const v of s.visites) v.essais.sort((a, b) => a.numero - b.numero);
  }
  state.arbo = data;
  renderArbo();
}

function renderArbo() {
  const nav = $("#arbo");
  nav.innerHTML = "";
  for (const s of state.arbo) {
    const nbEssais = s.visites.reduce((n, v) => n + v.essais.length, 0);
    const ds = div("sujet-row");
    ds.append(el("span", null, s.code), el("span", "badge count", `${nbEssais} essai${nbEssais > 1 ? "s" : ""}`));
    nav.append(ds);
    for (const v of s.visites) {
      const dv = div("visite-row");
      dv.textContent = `Visite ${v.numero}` + (v.date_visite ? ` · ${fmtDate(v.date_visite)}` : "");
      nav.append(dv);
      for (const e of v.essais) {
        const de = div("essai-row");
        de.append(el("span", null, `Essai ${e.numero}`),
          el("span", "badge " + (e.statut === "annote" ? "annote" : "afaire"),
            e.statut === "annote" ? "annoté" : "à faire"));
        if (state.essai && state.essai.id === e.id) de.classList.add("active");
        de.addEventListener("click", () => selectionnerEssai(e, s, v));
        nav.append(de);
      }
    }
  }
}

/* ---------- sélection d'un essai ---------- */
async function selectionnerEssai(essai, sujet, visite) {
  state.essai = essai;
  state.events = [];
  state.undoStack = [];
  state.playing = false;
  majBoutonPlay();
  renderArbo();
  $("#chargement").classList.remove("hidden");
  try {
    state.data = await chargerJson(essai.fichier);
  } catch (e) {
    toast(e.message);
    $("#chargement").classList.add("hidden");
    return;
  }
  const { data: events, error } = await sb.from("evenements").select("*").eq("essai_id", essai.id).order("image");
  if (error) { toast("Erreur événements : " + error.message); }
  else { state.events = events; }

  state.frame = 0;
  $("#titre").textContent = `${sujet.code} · Visite ${visite.numero} · Essai ${essai.numero}`;
  $("#sous-titre").textContent =
    `${essai.nb_images} images · ${essai.frequence_hz} Hz · ${fmtS(essai.nb_images / essai.frequence_hz)}`;
  viewer.charger(state.data);
  $("#chargement").classList.add("hidden");
  majTout();
}

function majTout() {
  viewer.setFrame(state.frame);
  majInfos();
  majTemps();
  majCurseur();
  majListeEvents();
  majBarres();
  majParams();
}

/* ---------- lecture / navigation ---------- */
viewer.onTick = (dt) => {
  if (!state.playing || !state.data) return;
  const nb = state.data.nbImages;
  const nouveau = state.frame + dt * 25 * state.speed;
  if (nouveau >= nb - 1) {
    state.frame = 0; // boucle
  } else {
    state.frame = nouveau;
  }
  viewer.setFrame(Math.floor(state.frame));
  majInfos();
  majTemps();
  majCurseur();
};

function allerA(f, garderLecture = false) {
  if (!state.data) return;
  const nb = state.data.nbImages;
  if (!garderLecture) setLecture(false);
  state.frame = Math.min(nb - 1, Math.max(0, f));
  viewer.setFrame(state.frame);
  majInfos();
  majTemps();
  majCurseur();
  surlignerEventCourant();
}

function setLecture(v) {
  state.playing = v;
  majBoutonPlay();
}
function majBoutonPlay() {
  $("#t-play").textContent = state.playing ? "⏸" : "▶";
}

$("#t-play").addEventListener("click", () => setLecture(!state.playing));
$("#t-debut").addEventListener("click", () => allerA(0));
$("#t-fin").addEventListener("click", () => allerA((state.data?.nbImages || 1) - 1));
$("#t-reculer").addEventListener("click", () => allerA(Math.floor(state.frame) - 1));
$("#t-avancer").addEventListener("click", () => allerA(Math.floor(state.frame) + 1));
document.querySelectorAll(".sbtn").forEach((b) =>
  b.addEventListener("click", () => {
    state.speed = parseFloat(b.dataset.v);
    document.querySelectorAll(".sbtn").forEach((x) => x.classList.toggle("active", x === b));
  })
);

/* ---------- affichages de l'image courante ---------- */
function majInfos() {
  if (!state.data) return;
  const nb = state.data.nbImages;
  const f = Math.floor(state.frame);
  $("#infos-ligne").textContent =
    `Image ${f} / ${nb - 1} · ${fmtS(f / state.data.frequence)}`;
  majEtatPied("g", "G");
  majEtatPied("d", "D");
}
function majEtatPied(elemId, pied) {
  const elm = $("#etat-" + elemId);
  if (piedAuSol(pied, Math.floor(state.frame))) {
    elm.textContent = "au sol";
    elm.className = "sol";
  } else {
    elm.textContent = "levé";
    elm.className = "leve";
  }
}

// événements d'un pied, triés par image (l'ordre d'insertion ne compte pas)
function evtsTries(pied) {
  return state.events.filter((e) => e.pied === pied).sort((a, b) => a.image - b.image);
}

// au sol si, d'après les événements annotés (sinon le contact_sol du fichier),
// une pose a été posée sans lever ensuite à cette image
function piedAuSol(pied, f) {
  const evts = evtsTries(pied);
  if (evts.length) {
    let pose = null;
    for (const e of evts) {
      if (e.type === "pose") pose = e.image;
      else if (pose !== null && f >= pose && f < e.image) return true;
      else if (pose !== null && f >= e.image) pose = null;
    }
    if (pose !== null && f >= pose) return true; // pose en attente de lever
    return false;
  }
  return state.data.contactSol[pied][f] === 1;
}

function majTemps() {
  $("#temps").textContent = fmtTemps(Math.floor(state.frame) / state.data.frequence);
}

/* ---------- barres d'appui ---------- */
function pairesContact(pied) {
  // couple chaque pose avec le lever qui suit (ordre chronologique)
  const evts = evtsTries(pied);
  const paires = [];
  let pose = null;
  for (const e of evts) {
    if (e.type === "pose") pose = e.image;
    else if (pose !== null) { paires.push([pose, e.image]); pose = null; }
  }
  if (pose !== null) paires.push([pose, state.data.nbImages - 1]);
  return paires;
}

function majBarres() {
  if (!state.data) return;
  const nb = state.data.nbImages;
  for (const [id, pied] of [["#barre-g", "G"], ["#barre-d", "D"]]) {
    const barre = $(id);
    barre.innerHTML = "";
    // référence : contact_sol du fichier (léger, en fond)
    const cs = state.data.contactSol[pied];
    let debut = null;
    for (let f = 0; f <= nb; f++) {
      const on = f < nb && cs[f] === 1;
      if (on && debut === null) debut = f;
      if (!on && debut !== null) {
        barre.append(spanBarre(debut, f - 1, "span-ref", pied, nb));
        debut = null;
      }
    }
    // annotation : événements posés par l'utilisateur (pleins)
    for (const [a, b] of pairesContact(pied)) {
      barre.append(spanBarre(a, b, "span-evt", pied, nb));
    }
  }
}

function spanBarre(a, b, classe, pied, nb) {
  const s = document.createElement("span");
  s.className = classe;
  s.style.color = pied === "G" ? "var(--cyan)" : "var(--orange)";
  s.style.left = (a / (nb - 1)) * 100 + "%";
  s.style.width = Math.max(0.3, ((b - a) / (nb - 1)) * 100) + "%";
  return s;
}

function majCurseur() {
  const nb = state.data?.nbImages || 1;
  $("#curseur").style.left = `calc(${(Math.floor(state.frame) / (nb - 1)) * 100}% )`;
}
// clic sur une barre = aller à cette image
for (const id of ["#barre-g", "#barre-d"]) {
  $(id).addEventListener("click", (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    const frac = (e.clientX - r.left) / r.width;
    allerA(Math.round(frac * ((state.data?.nbImages || 1) - 1)));
  });
}

/* ---------- paramètres calculés ---------- */
function majParams() {
  if (!state.data) return;
  const duree = state.data.nbImages / state.data.frequence;
  const poses = state.events.filter((e) => e.type === "pose").length;
  $("#p-cadence").textContent = poses ? `${Math.round(poses / duree * 60)} pas/min` : "—";
  for (const [id, pied] of [["#p-appui-g", "G"], ["#p-appui-d", "D"]]) {
    const paires = pairesContact(pied);
    const tempsAppui = paires.reduce((s, [a, b]) => s + (b - a), 0) / state.data.frequence;
    $(id).textContent = paires.length ? `${Math.round(tempsAppui / duree * 100)} %` : "—";
  }
}

/* ---------- événements (pose / lever) ---------- */
document.querySelectorAll(".evt-btn").forEach((b) =>
  b.addEventListener("click", () => ajouterEvent(b.dataset.pied, b.dataset.type))
);

// L'utilisateur repose le même type d'événement : s'agit-il d'une correction
// (on déplace) ou d'un nouvel instant (on crée) ?
// - si le dernier événement du pied est du même type (pose ouverte) : déplacer ;
// - sinon, si un événement du même type est à moins d'une demi-seconde : déplacer ;
// - sinon : créer (nouvelle foulée).
function cibleCorrection(pied, type, image) {
  const evts = evtsTries(pied);
  const dernier = evts[evts.length - 1];
  if (dernier && dernier.type === type) return dernier;
  const seuil = state.data.frequence / 2;
  let meilleure = null, dmin = Infinity;
  for (const e of evts) {
    if (e.type !== type) continue;
    const d = Math.abs(e.image - image);
    if (d < dmin) { dmin = d; meilleure = e; }
  }
  return dmin <= seuil ? meilleure : null;
}

async function ajouterEvent(pied, type) {
  if (!state.data) return;
  const image = Math.floor(state.frame);
  if (state.events.some((e) => e.pied === pied && e.type === type && e.image === image)) {
    toast("Cet événement est déjà marqué sur cette image");
    return;
  }
  const cible = cibleCorrection(pied, type, image);
  const nom = `${type === "pose" ? "Pose" : "Lever"} ${pied}`;
  if (cible) {
    // correction : on déplace l'événement existant
    const ancienneImage = cible.image;
    const { data, error } = await sb.from("evenements")
      .update({ image }).eq("id", cible.id).select().single();
    if (error) { toast("Erreur d'enregistrement : " + error.message); return; }
    state.events = state.events.map((e) => (e.id === cible.id ? data : e));
    state.undoStack.push({ id: cible.id, image: ancienneImage }); // Ctrl+Z remet l'ancienne image
    majTout();
    toast(`${nom} déplacé${pied === "G" ? "e" : ""} à l'image ${image}`);
    surlignerEventCourant();
    return;
  }
  const { data, error } = await sb.from("evenements")
    .insert({ essai_id: state.essai.id, pied, type, image }).select().single();
  if (error) { toast("Erreur d'enregistrement : " + error.message); return; }
  state.events.push(data);
  state.undoStack.push({ id: data.id, image: null });
  majListeEvents();
  majBarres();
  majParams();
  majInfos();
  toast(`${nom} ajouté${pied === "G" ? "e" : ""} à l'image ${image}`);
  surlignerEventCourant();
}

async function supprimerEvent(id) {
  const { error } = await sb.from("evenements").delete().eq("id", id);
  if (error) { toast("Erreur de suppression : " + error.message); return; }
  state.events = state.events.filter((e) => e.id !== id);
  state.undoStack = state.undoStack.filter((x) => x.id !== id);
  majListeEvents();
  majBarres();
  majParams();
  majInfos();
}

async function restaurerEvent(id, image) {
  const { data, error } = await sb.from("evenements").update({ image }).eq("id", id).select().single();
  if (error) { toast("Erreur d'annulation : " + error.message); return; }
  state.events = state.events.map((e) => (e.id === id ? data : e));
  majTout();
}

function majListeEvents() {
  const liste = $("#liste-events");
  liste.innerHTML = "";
  $("#nb-events").textContent = state.events.length;
  if (!state.events.length) {
    const d = div("vide");
    d.textContent = "Aucun événement. Avance image par image et utilise les boutons Pose / Lever.";
    liste.append(d);
    return;
  }
  const tri = [...state.events].sort((a, b) =>
    a.image - b.image || a.pied.localeCompare(b.pied) || a.type.localeCompare(b.type));
  for (const e of tri) {
    const d = div(`evt evt-${e.pied}`);
    d.dataset.image = e.image;
    if (Math.floor(state.frame) === e.image) d.classList.add("active");
    const t = e.image / state.data.frequence;
    d.append(
      el("span", "tri", e.type === "pose" ? "▼" : "▲"),
      el("span", "lab", `${e.type === "pose" ? "Pose" : "Lever"} ${e.pied}`),
      el("span", "meta", `img ${e.image} · ${fmtS(t)}`),
    );
    const btn = el("button", "del", "×");
    btn.title = "Supprimer";
    btn.addEventListener("click", (ev) => { ev.stopPropagation(); supprimerEvent(e.id); });
    d.append(btn);
    d.addEventListener("click", () => allerA(e.image));
    liste.append(d);
  }
}

function surlignerEventCourant() {
  const f = Math.floor(state.frame);
  document.querySelectorAll("#liste-events .evt").forEach((d) =>
    d.classList.toggle("active", d.dataset.image !== undefined && +d.dataset.image === f));
}

/* ---------- Enregistrer / Export / Nouveau sujet ---------- */
$("#btn-enregistrer").addEventListener("click", async () => {
  if (!state.essai) return;
  const { error } = await sb.from("essais").update({ statut: "annote" }).eq("id", state.essai.id);
  if (error) { toast("Erreur : " + error.message); return; }
  state.essai.statut = "annote";
  const s = state.arbo.find((x) => x.visites.some((v) => v.essais.some((e) => e.id === state.essai.id)));
  if (s) { for (const v of s.visites) for (const e of v.essais) if (e.id === state.essai.id) e.statut = "annote"; }
  renderArbo();
  toast("Essai enregistré ✓");
});

$("#btn-export").addEventListener("click", () => {
  if (!state.essai || !state.data) return;
  const lignes = [["sujet", "visite", "essai", "image", "temps_s", "pied", "evenement"]];
  const m = state.essai.fichier.match(/^(S\d+)_V(\d+)_E(\d+)\.json$/);
  for (const e of [...state.events].sort((a, b) => a.image - b.image)) {
    lignes.push([m?.[1] || "", m?.[2] || "", m?.[3] || "", e.image,
      (e.image / state.data.frequence).toFixed(2), e.pied === "G" ? "gauche" : "droit",
      e.type === "pose" ? "pose" : "lever"]);
  }
  const csv = "﻿" + lignes.map((l) => l.join(";")).join("\r\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = (state.essai.fichier.replace(".json", "")) + "_evenements.csv";
  a.click();
  URL.revokeObjectURL(a.href);
});

$("#btn-nouveau-sujet").addEventListener("click", async () => {
  const code = (prompt("Code du nouveau sujet (par exemple S04) :") || "").trim().toUpperCase();
  if (!code) return;
  const { data, error } = await sb.from("sujets").insert({ code }).select().single();
  if (error) { toast("Erreur : " + error.message); return; }
  data.visites = [];
  state.arbo.push(data);
  state.arbo.sort((a, b) => a.code.localeCompare(b.code));
  renderArbo();
  toast(`Sujet ${code} créé. Les visites et essais viendront des fichiers du dossier essais.`);
});

/* ---------- clavier ---------- */
window.addEventListener("keydown", (e) => {
  const tag = document.activeElement?.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA") return;

  if (e.ctrlKey && e.key.toLowerCase() === "z") {
    e.preventDefault();
    const dernier = state.undoStack.pop();
    if (!dernier) return;
    if (dernier.image === null) {
      // c'était une création : on la supprime
      supprimerEvent(dernier.id);
    } else {
      // c'était un déplacement : on remet l'ancienne image
      restaurerEvent(dernier.id, dernier.image);
    }
    return;
  }
  switch (e.code) {
    case "Space": e.preventDefault(); setLecture(!state.playing); return;
    case "ArrowLeft": e.preventDefault(); allerA(Math.floor(state.frame) - (e.shiftKey ? 10 : 1)); return;
    case "ArrowRight": e.preventDefault(); allerA(Math.floor(state.frame) + (e.shiftKey ? 10 : 1)); return;
  }
  if (e.repeat) return;
  switch (e.key.toLowerCase()) {
    case "f": ajouterEvent("G", "pose"); break;
    case "g": ajouterEvent("G", "lever"); break;
    case "c": ajouterEvent("D", "pose"); break;
    case "b": ajouterEvent("D", "lever"); break;
  }
});

/* ---------- aides DOM ---------- */
function el(tag, classe, text) {
  const d = document.createElement(tag);
  if (classe) d.className = classe;
  if (text !== undefined) d.textContent = text;
  return d;
}
function div(classe) {
  const d = document.createElement("div");
  if (classe) d.className = classe;
  return d;
}

/* ---------- démarrage ---------- */
await chargerArbo();
// ouvre le premier essai par défaut
const premier = state.arbo[0]?.visites[0]?.essais[0];
if (premier) {
  const s = state.arbo[0], v = state.arbo[0].visites[0];
  await selectionnerEssai(premier, s, v);
}
