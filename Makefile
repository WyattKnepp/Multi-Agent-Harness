# Project hosting for the idea pipeline: GitHub repo, droplet clone, pm2 app
# and Caddy site per project. Thin wrapper; the logic is in scripts/deploy.js
# (laptop side) and scripts/remote/*.sh (run on the droplet over ssh).
# Settings: .env; per-project overrides: projects.deploy.json. See CLAUDE.md.
#
#   make test    PROJECT=x             run x's tests/ with node:test, write x/test-report.testreport
#   make skill   PROJECT=x | ALL=1     install the test-report skill into x (or every project)
#   make new     PROJECT=x [VISIBILITY=private|public]  repo + droplet clone + port
#   make deploy  PROJECT=x [IDEA=id]   test, push, pull on droplet, build, (re)start,
#                                      health check; rolls back on failure
#   make caddy   PROJECT=x             write/refresh the project's Caddy site
#   make restart PROJECT=x | make logs PROJECT=x [LINES=n] | make status [PROJECT=x]
#   make remove  PROJECT=x             undo make new on the droplet (keeps GitHub + laptop)
#
# Add DRY_RUN=1 to any target to print what it would do instead.
# From anywhere: make -C /path/to/this/repo deploy PROJECT=x

export PROJECT IDEA VISIBILITY DRY_RUN LINES FORCE ALL

DEPLOY := node $(CURDIR)/scripts/deploy.js

TARGETS := test skill new deploy caddy restart status logs remove
.PHONY: $(TARGETS) help
help:
	@sed -n '/^#   make/p' $(firstword $(MAKEFILE_LIST)) | sed 's/^#   //'
$(TARGETS):
	@$(DEPLOY) $@
