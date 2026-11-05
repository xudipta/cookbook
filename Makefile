YAML_FILES=$(shell find . -type f \( -name '*.yaml' -o -name '*.yml' \) ! -path './venv/*' ! -path './.git/*' ! -path './.github/*')
MD_FILES=$(shell find . -type f -name '*.md' ! -path './venv/*' ! -path './.git/*' ! -path './site-src/*')

.PHONY: lint lint-md format venv docs docs-serve screenshots unit help

lint:
	@yamllint $(YAML_FILES)

lint-md:
	@npx --yes markdownlint-cli2 $(MD_FILES)

format:
	@for file in $(YAML_FILES); do \
		python3 scripts/format_yaml.py $$file || echo "Could not format $$file"; \
	done

venv:
	@python3 -m venv venv && \
	. venv/bin/activate && \
	pip install --upgrade pip && \
	pip install -r requirements.txt -r requirements-docs.txt && \
	echo "Virtual environment created in venv and dependencies installed" || echo "Failed to create venv"

docs:
	@bash scripts/build_docs.sh && mkdocs build --strict

docs-serve:
	@bash scripts/build_docs.sh && mkdocs serve

# Unit-test the pure game simulators (Node 22 or newer, no dependencies; takes about a second).
unit:
	node --test "docs/games/**/*.test.mjs"

# Rebuild the site, serve it on a free port, regenerate the README/home screenshots, stop the server.
screenshots:
	@bash scripts/build_docs.sh && mkdocs build --strict
	@PORT=$$(python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1])'); \
	python3 -m http.server $$PORT --directory site >/dev/null 2>&1 & PID=$$!; \
	trap 'kill $$PID 2>/dev/null' EXIT; \
	for i in 1 2 3 4 5 6 7 8 9 10; do curl -sf http://127.0.0.1:$$PORT/ >/dev/null && break; sleep 1; done; \
	SITE_URL=http://127.0.0.1:$$PORT/ node scripts/screenshots.cjs

help:
	@echo "Available targets:"
	@echo "  lint        - Run yamllint on all YAML files."
	@echo "  lint-md     - Run markdownlint on all Markdown files (requires npx)."
	@echo "  format      - Normalise YAML formatting (ruamel.yaml)."
	@echo "  venv        - Create ./venv and install Python dependencies."
	@echo "  docs        - Assemble site-src/ and build the site (strict)."
	@echo "  docs-serve  - Assemble site-src/ and serve the site locally."
	@echo "  screenshots - Rebuild the site and regenerate the README/home screenshots (needs playwright)."
	@echo "  help        - Show this help message."
