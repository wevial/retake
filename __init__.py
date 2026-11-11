"""Retake's stock-Hermes registration: one slash command, nothing else.

`register(ctx)` only records which Hermes profile this plugin instance was loaded in and registers
`/retake-generate <attempt-id>`. It starts no jobs, threads or tools and writes no state. The command
runs exactly one attempt the Retake page already reserved (see stock_bridge.py); it never creates
an attempt itself and never treats a repeated command as permission to regenerate.
"""
import re

_ATTEMPT_ID = re.compile(r'^[0-9a-f]{32}$')


def _registered_home():
    # A read of the host-bound profile home at load time; no directory is created.
    try:
        from hermes_constants import get_hermes_home
        return str(get_hermes_home())
    except Exception:
        return None


def register(ctx):
    pinned_home = _registered_home()

    def retake_generate(raw_args=''):
        # Validate before any import, storage access or tool dispatch.
        value = raw_args.strip() if isinstance(raw_args, str) else ''
        if not _ATTEMPT_ID.fullmatch(value):
            return 'Retake: expected exactly one 32-character attempt ID from the Retake page. Nothing was sent.'
        from . import stock_bridge
        return stock_bridge.run(ctx, pinned_home, value)

    ctx.register_command(
        'retake-generate', retake_generate,
        description='Run one image generation already reserved and confirmed on the Retake page',
        args_hint='<attempt-id>')
    return None
