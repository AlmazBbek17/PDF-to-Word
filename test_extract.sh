mkdir -p /tmp/extest && cd /tmp/extest
cp /home/claude/testpdf/test_invoice.pdf input.pdf
pdfinfo input.pdf | grep Pages
