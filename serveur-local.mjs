// Petit serveur de fichiers statiques pour tester en local (remplace `python -m http.server`)
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

const racine = new URL(".", import.meta.url).pathname.slice(1);
const types = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".png": "image/png", ".svg": "image/svg+xml",
};
const port = process.argv[2] || 8777;

createServer(async (req, res) => {
  try {
    let chemin = decodeURIComponent(new URL(req.url, "http://x").pathname);
    if (chemin.endsWith("/")) chemin += "index.html";
    const fichier = normalize(join(racine, chemin));
    if (!fichier.startsWith(normalize(racine))) throw new Error();
    const contenu = await readFile(fichier);
    res.writeHead(200, { "Content-Type": types[extname(fichier)] || "application/octet-stream" });
    res.end(contenu);
  } catch {
    res.writeHead(404);
    res.end("introuvable");
  }
}).listen(port, () => console.log(`http://localhost:${port}`));
