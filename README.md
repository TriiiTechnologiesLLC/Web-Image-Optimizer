# Web Image Optimizer GUI

A high-performance, desktop-based Graphical User Interface for transforming and altering images to be better served over a web environment, in addition to small tools tailored at image manipulation to better assist developers in rapid deployment.

This tool provides batch processing capabilities with advanced options for format conversion and metadata redaction, wrapped in a modern, dark-mode interface.

---

## 📦 Features

### Image Processing
- **Batch Optimization**: Efficiently processes multiple files simultaneously using a dedicated background runtime thread.
- **WebP Conversion**: Transform legacy image formats (PNG, JPEG, etc.) into the highly efficient WebP format for faster web loading.

### Privacy & Data Hygiene
- **EXIF Stripping**: Completely removes technical metadata from images to reduce file bloat.
- **GPS Redaction**: Securely scrubs precise location coordinates from EXIF headers to protect user privacy before sharing.

### User Interface
- **Modern Dark Mode**: Built with a sleek "Catppuccin" inspired dark theme for reduced eye strain during heavy processing tasks.
- **Real-Time Logging**: Live terminal console that tracks system logs and file processing status in real-time.
- **SweetAlert2 Integration**: Provides smooth, non-blocking pop-ups for warnings, loading states, and success notifications.

---

## 🛠 Installation & Setup

This project is built using web technologies (HTML/CSS/JS) wrapped in an Electron runtime environment.

### Prerequisites
- Node.js installed on your machine.

### Getting Started

1. **Clone the repository:**
   ```bash
   git clone https://github.com/triiitechnologies/web-image-optimizer.git
   cd web-image-optimizer
   ```

2. **Install dependencies:**
   ```bash
   npm install
   ```

3. **Run the application:**
   ```bash
   npm start
   ```

---

## 🖥 Usage Guide

1.  **Select Source**: Click "Browse Source" and select the folder containing the images you wish to optimize.
2.  **Select Output**: Click "Browse Output" and choose where you want the converted files saved.
3.  **Configure Options**: 
    -   Check **"Optimize Images with WebP Format"** if you need web-ready conversions.
    -   Check **"Strip Metadata (EXIF)"** to clean file headers.
    -   Check **"Redact GPS Coordinates"** to ensure location privacy.
4.  **Run**: Click the **"Optimize Images"** button. The live log console will track the progress of your batch job.

---

## 🏗 Technical Stack

*   **Frontend**: HTML5, CSS3 (Custom Variables), Vanilla JavaScript.
*   **UI Components**: SweetAlert2 (Modal alerts & spinners).
*   **Runtime**: Electron.js (Native file system access via `window.electronAPI`).
*   **Architecture**: Separated UI thread from the main processing logic for high performance.

---

## 📜 License

This project is licensed under the MIT License - see the [LICENSE] file for details.

> Copyright 2026 Triii Technologies LLC  
> Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the “Software”), to deal in the Software without restriction.
