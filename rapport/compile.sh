#!/usr/bin/env bash
set -e
echo "============================================"
echo "  Compilation du rapport PFE - SprintUp"
echo "============================================"

echo "Suppression des anciens fichiers temporaires..."
rm -f main.aux main.bbl main.blg main.bcf main.run.xml \
      main.glo main.gls main.glsdefs main.ist main.acn main.acr main.alg \
      main.toc main.lof main.lot main.lol main.out

echo "[1/5] pdfLaTeX (premiere passe)..."
pdflatex -interaction=nonstopmode main.tex >/dev/null

echo "[2/5] BibTeX (references bibliographiques)..."
bibtex main

echo "[3/5] makeglossaries (acronymes)..."
makeglossaries main

echo "[4/5] pdfLaTeX (deuxieme passe)..."
pdflatex -interaction=nonstopmode main.tex >/dev/null

echo "[5/5] pdfLaTeX (troisieme passe - finalisation)..."
pdflatex -interaction=nonstopmode main.tex >/dev/null

echo "============================================"
echo "  Compilation terminee : main.pdf"
echo "============================================"
ls -la main.pdf
