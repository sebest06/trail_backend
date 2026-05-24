#!/bin/bash

# Script para ejecutar los tests de la API de AppRadar
# Uso: ./run_tests.sh [URL_DEL_BACKEND]

API_URL=${1:-"http://localhost:3000"}

echo "Ejecutando tests contra: $API_URL"
echo "-----------------------------------"

API_URL=$API_URL node tests/api_tests.js
