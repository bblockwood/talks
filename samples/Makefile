# Builds the sample deck offered on the opening page, into public/samples/ (committed, and served
# as it is). Run `make` here after editing tour.tex.
# Its screenshots (img/) are retaken with shots.mjs; see the top of that file.
../public/samples/tour.pdf: tour.tex $(wildcard img/*.png)
	latexmk -g -pdf -interaction=nonstopmode -halt-on-error -outdir=.build tour.tex
	cp .build/tour.pdf $@

clean:
	rm -rf .build
