#!/bin/bash

set -e

npm ci
npm run format:check
npm run typecheck
npm run build
npm test
