import React from 'react';
import { createRoot } from 'react-dom/client';
// Base styles load first so feature stylesheets imported by components can refine them.
import './styles.css';
import App from './App.jsx';
createRoot(document.getElementById('root')).render(<App />);
