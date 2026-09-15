# 🌍 i18n Flattener CLI

Un script Node.js interactif conçu pour simplifier et aplatir les fichiers de traduction JSON complexes (nesting profond), tout en mettant à jour automatiquement toutes les références associées dans le code source de l'application (fichiers Vue, TS, JS) et dans les tests.

## ✨ Fonctionnalités principales

- **Aplatissement intelligent** : Réduit la profondeur des clés de traduction à 2 niveaux maximum (ex: `header.userProfile.logoutButton` devient `header.logoutButtonUserProfile`).
- **Mise à jour globale** : Modifie simultanément les fichiers JSON de traduction (`fr.json`, `en.json`), la section `quarantinedKeys`, le code source et les fichiers de tests (Unitaires et E2E).
- **Protection anti-casse (Dry Run)** : Si une clé est générée dynamiquement dans le code (et donc introuvable telle quelle, trouvée uniquement dans les tests), le script la détecte et **refuse de la modifier** pour ne pas casser l'application.
- **Tri automatique** : Trie alphabétiquement l'intégralité des fichiers de traduction JSON avant chaque sauvegarde pour éviter les conflits Git.
- **Mode Interactif ou Auto** : Validez les modifications groupe par groupe, éditez manuellement une clé, ou laissez le script tout traiter de manière autonome.
- **Rapport détaillé** : Génère un fichier Markdown (`ignored_keys_report.md`) en fin d'exécution avec le bilan des modifications et des liens cliquables vers les fichiers impactés.

---

## 🚀 Installation & Lancement

1. Assurez-vous d'avoir initialisé le projet avec `npm init -y` et d'avoir configuré l'import ES6 dans le `package.json` :

```json
   {
     "name": "i18n-flattener",
     "version": "1.0.0",
     "type": "module",
     "scripts": {
       "start": "node index.js"
     }
   }

```

2. Installez Node.js (version 14+ recommandée). Aucune dépendance externe n'est requise.

3. Lancez le script :
```bash
npm start

```



---

## ⚙️ Configuration (`config.json`)

Le script s'appuie sur un fichier `config.json` placé à la racine du dossier.

Exemple de configuration :

```json
{
  "projectRoot": "../ETERNITE_N1/client",
  "e2eRoot": "../ETERNITE_N1/specs/src",
  "translationFiles": [
    "../ETERNITE_N1/client/i18n/locales/fr.json",
    "../ETERNITE_N1/client/i18n/locales/en.json"
  ],
  "ignoredParentKeys": [
    "carto"
  ],
  "maxDepthAllowed": 2,
  "fileExtensions": [".js", ".jsx", ".ts", ".tsx", ".vue"],
  "testFilePatterns": [".unit.", ".integration.", ".intergration."],
  "autoMode": false
}

```

### Détail des paramètres :

* `projectRoot` : Le chemin vers le dossier contenant le code source front-end.
* `e2eRoot` *(Optionnel)* : Le chemin vers le dossier contenant les tests End-to-End.
* `translationFiles` : Les fichiers JSON à mettre à jour. (Le premier fichier de la liste sert de référence pour la détection).
* `ignoredParentKeys` : Les clés racines à ignorer totalement (ex: `"carto"`).
* `maxDepthAllowed` : La profondeur à partir de laquelle les clés doivent être aplaties (généralement `2`).
* `testFilePatterns` : Les mots-clés dans les noms de fichiers qui permettent au script d'identifier les tests.
* `autoMode` : Si `true`, le script valide toutes les propositions automatiquement sans demander confirmation.

---

## 🛠️ Utilisation et Commandes CLI

Le script regroupe les clés par "chemin parent" (ex: toutes les clés sous `cartographySettings.display`).
Pour chaque groupe, les choix suivants vous sont proposés :

* `[Entrée]` : Accepter les suggestions de renommage pour tout le groupe.
* `[s]` *(Skip)* : Ignorer ce groupe (il ne sera pas modifié).
* `[m]` *(Modifier)* : Éditer manuellement le nom de la nouvelle clé, une par une.
* `[a]` *(Auto)* : Activer le mode automatique pour ce groupe et **tous les groupes suivants**.

---

## 🧠 Logique de renommage

La règle de renommage appliquée par le script prend la clé de niveau 1, la dernière clé (la feuille), et intercale les clés intermédiaires de la plus éloignée à la plus proche en **camelCase**.

**Exemple :**

Ancienne clé (profondeur 4) : `cartographySettings.display.advanced.baseMapTint`

* Clé Niv 1 : `cartographySettings`
* Dernière clé : `baseMapTint`
* Clés intermédiaires inversées : `advanced` puis `display`
* **Nouvelle clé : `cartographySettings.baseMapTintAdvancedDisplay**`

---

## 🛡️ Sécurité : Code Source vs Tests

Pour éviter de corrompre des traductions appelées de manière dynamique (ex: `t('cemeteries.toast.' + action)`), le script effectue une passe de vérification stricte :

1. Il cherche la chaîne de caractères exacte dans les fichiers **sources**.
2. Il cherche la chaîne exacte dans les fichiers de **tests** (`testFilePatterns` & `e2eRoot`).
3. Il cherche la clé dans la section `quarantinedKeys` du JSON.

**Règle d'application :**

* Si la clé est trouvée dans le **code source** ou en **quarantaine** 👉 Validation accordée. Le JSON, la source et les tests sont mis à jour.
* Si la clé n'est trouvée **QUE dans les tests** 👉 Validation refusée. Le script suppose que la source utilise une interpolation dynamique. Le JSON n'est pas modifié.

---

## 📋 Le Rapport Final (`ignored_keys_report.md`)

Une fois l'exécution terminée, un fichier Markdown est généré. Il liste de manière exhaustive toutes les actions entreprises par le script :

* **✅ Les clés mises à jour :** Liste les anciennes/nouvelles clés, indique si la quarantaine a été touchée, et fournit des **liens cliquables** (pour VS Code/WebStorm) vers les fichiers sources et tests modifiés.
* **🚫 Les clés ignorées :** Liste les clés laissées intactes et explique pourquoi (ex: "Trouvé uniquement dans des tests", "Introuvable partout"). Fournit les liens vers les fichiers de tests pour faciliter une éventuelle correction manuelle.
