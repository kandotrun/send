/// <reference types="vite/client" />

interface Window {
  showSaveFilePicker?: import("./save.ts").SaveFilePicker;
}
