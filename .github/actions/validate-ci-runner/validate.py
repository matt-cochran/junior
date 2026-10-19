#!/usr/bin/env python3
"""Validate the manual runner switch. Automatic billing routing is not enabled."""
import json
import os
import sys

def validate(mode, runner):
    mode = mode or "github"
    if mode not in ("github", "blacksmith"):
        raise ValueError("CI_RUNNER_MODE must be github or blacksmith; auto requires a separately validated billing controller")
    expected = "blacksmith-2vcpu-ubuntu-2404" if mode == "blacksmith" else "github"
    if mode == "blacksmith" and runner != expected:
        raise ValueError("Blacksmith routing requires its verified Ubuntu 24.04 x64 label")
    return {"mode": mode, "provider": mode, "automatic_routing": False}

if __name__ == "__main__":
    try:
        print(json.dumps(validate(os.environ.get("CI_RUNNER_MODE",""), os.environ.get("CI_RUNNER_LABEL",""))))
    except ValueError as error:
        print("::error::"+str(error), file=sys.stderr)
        sys.exit(1)
