<div align="center">

# 🧾 Kautim

**split the bill, settle the tab, skip the awkward maths**

*"Kautim" — Malaysian slang for "sort it out" / "settle it."*

[![Live App](https://img.shields.io/badge/live-kautim--app-2451B5?style=flat-square)](https://maxloh67.github.io/kautim-app/)
[![React](https://img.shields.io/badge/React-18-61DAFB?style=flat-square&logo=react&logoColor=white)](https://react.dev)
[![Vite](https://img.shields.io/badge/Vite-5-646CFF?style=flat-square&logo=vite&logoColor=white)](https://vitejs.dev)
[![Firebase](https://img.shields.io/badge/Firebase-Auth%20%2B%20Firestore-FFCA28?style=flat-square&logo=firebase&logoColor=black)](https://firebase.google.com)
[![License: MIT](https://img.shields.io/badge/license-MIT-lightgrey?style=flat-square)](#license)

</div>

---

Every friend group has that one dinner where nobody wants to do the maths. Someone always overpays. Someone always "forgets." Someone always screenshots a calculator app into the group chat at 1am.

**Kautim fixes that.** Snap the receipt, tap who ate what, and it does the tax-and-service-charge maths for you — down to the ringgit. Then it hands you a clean message to drop in Discord, and a link everyone can open to see exactly what *they* owe, pay it, and mark it settled.

## ✨ What it does

| | |
|---|---|
| 🧾 **Ledger** | Every bill you've ever split, at a glance — who's paid, who's still outstanding. |
| ➕ **New Bill** | Add items, assign them per person, and Kautim splits tax + service proportionally. Scan the receipt with your camera and it fills in the items for you. |
| 👥 **People** | Your crew's roster — names, Discord IDs, payment QR codes, all in one place. |
| ✅ **Verified payments** | When someone marks a bill "paid" from their shared link, *you* approve the amount before it counts as settled — so numbers can't quietly drift or get gamed. |
| 🔗 **Shareable links** | Send anyone their personal breakdown of a bill. No account needed on their end. |

## 🛠 Built with

- **React 18 + Vite** — the app itself
- **Firebase Auth** (Google sign-in) + **Firestore** — accounts, sync, real data across devices
- **Firebase Cloud Functions** — a small server-side proxy that keeps API keys out of the browser
- **Google Cloud Vision API** — reads your receipt so you don't have to type it in
- **lucide-react** — icons
- **GitHub Pages** — where this thing actually lives

## 🚀 Running it yourself

```bash
git clone https://github.com/maxloh67/kautim-app.git
cd kautim-app
npm install
```

Create `src/firebase.js` with your own Firebase project config (this file is gitignored — never commit real credentials):

```js
import { initializeApp } from 'firebase/app';
import { getAuth, GoogleAuthProvider } from 'firebase/auth';
import { getFirestore } from 'firebase/firestore';

const firebaseConfig = {
  apiKey: "...",
  authDomain: "...",
  projectId: "...",
  storageBucket: "...",
  messagingSenderId: "...",
  appId: "..."
};

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const googleProvider = new GoogleAuthProvider();
export const db = getFirestore(app);
```

Then:

```bash
npm run dev
```

## 📸 Receipt scanning

Snapping a photo of a receipt calls a Firebase Cloud Function (`functions/index.js`), which forwards it to Google Cloud Vision **server-side** — your Vision API key never touches the browser bundle, so it can't be scraped out of your deployed site.

To stand up your own copy:

```bash
cd functions
npm install
firebase functions:secrets:set VISION_API_KEY
# paste your Cloud Vision API key when prompted

cd ..
firebase deploy --only functions:scanReceipt
```

This needs your Firebase project on the **Blaze (pay-as-you-go)** plan — Cloud Functions and Secret Manager simply aren't available on the free Spark tier. In practice, a small friend group stays comfortably inside Google's *actual* free quotas (2M function calls/month, 1,000 Vision requests/month), so real-world cost lands at **$0**.

After deploying, update the function URL in `handleScanReceipt` inside `src/App.jsx` to match your own deployment.

## 📦 Shipping it

```bash
npm run deploy
```

Builds the app and pushes `dist/` to the `gh-pages` branch — GitHub Pages does the rest. This is separate from `firebase deploy` (above); a frontend change and a Cloud Function change don't need to ship together unless your edit touches both.

## 🗂 Project layout

```
kautim/
├── src/
│   ├── App.jsx        # the whole app lives here — views, components, logic
│   └── firebase.js     # your Firebase config (gitignored)
├── functions/
│   └── index.js         # Cloud Function: receipt OCR proxy
├── public/
└── package.json
```

## 🧡 A note on scope

This is a side project built for one specific friend group's dinners, not a general-purpose expense app — no multi-currency support, no export to accounting software, no ambitions beyond "did Hooman actually pay me back yet." That's on purpose.

## License

MIT — do whatever you want with it.