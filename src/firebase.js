import { initializeApp } from "firebase/app";
import { getAuth, GoogleAuthProvider, signInWithPopup } from "firebase/auth";
import { getFirestore } from "firebase/firestore";

const firebaseConfig = {
    apiKey: "AIzaSyBeumOkXIjzu5pSnDtwcUZB9RBnU_GD7ec",
    authDomain: "kautim-6b186.firebaseapp.com",
    projectId: "kautim-6b186",
    storageBucket: "kautim-6b186.firebasestorage.app",
    messagingSenderId: "597084369011",
    appId: "1:597084369011:web:4e289042db6d29995e3a06",
    measurementId: "G-T2X73MLMW7"
};

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);
export const googleProvider = new GoogleAuthProvider();