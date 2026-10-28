#!/usr/bin/env bash
# Copia los archivos Android nativos y el plugin Kotlin al proyecto generado por Capacitor.
# Uso: npm run cap:add:android && bash scripts/install-android-native.sh
set -euo pipefail

APP_ID="com.ark.arkpm" # debe coincidir con appId en capacitor.config.ts
PKG_DIR="android/app/src/main/java/${APP_ID//.//}"

[ -d android ] || {
  echo "No existe android/. Ejecuta primero: npm run cap:add:android"
  exit 1
}

[ -d android-native/android ] || {
  echo "No existe android-native/android/"
  exit 1
}

# 1. Copiar los archivos Android, excluyendo las carpetas .gradle
rsync -av \
  --exclude='/.gradle/' \
  --exclude='/app/.gradle/' \
  android-native/android/ android/

echo "Archivos Android copiados a android/"

# 2. Copiar el plugin Kotlin
mkdir -p "$PKG_DIR"
rm -f "$PKG_DIR/MainActivity.java"
cp android-native/kotlin/*.kt "$PKG_DIR/"

echo "Archivos Kotlin copiados a $PKG_DIR"
echo "Instalación completada."