@echo off
echo ============================================
echo   Compilation du rapport PFE - SprintUp
echo ============================================
echo.

echo Suppression des anciens fichiers temporaires...
del /f /q main.aux main.bbl main.blg main.bcf main.run.xml main.glo main.gls main.glsdefs main.ist main.acn main.acr main.alg main.toc main.lof main.lot main.lol main.out 2>nul
echo.

echo [1/5] pdfLaTeX (premiere passe)...
pdflatex -interaction=nonstopmode main.tex
echo.

echo [2/5] BibTeX (references bibliographiques)...
bibtex main
echo.

echo [3/5] makeglossaries (acronymes)...
makeglossaries main
echo.

echo [4/5] pdfLaTeX (deuxieme passe)...
pdflatex -interaction=nonstopmode main.tex
echo.

echo [5/5] pdfLaTeX (troisieme passe - finalisation)...
pdflatex -interaction=nonstopmode main.tex
echo.

echo ============================================
echo   Compilation terminee ! Ouverture du PDF...
echo ============================================
start main.pdf
pause
