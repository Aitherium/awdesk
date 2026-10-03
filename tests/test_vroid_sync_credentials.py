"""The desk's VRoid scripts read the app credentials from the vault, not a local file.

~/.aither/vroid_hub.env held the VRoid app id and secret on one machine; the
vault now holds both. ensure_app_credentials fills only what the environment lacks,
into this process, and prints nothing.
"""

import importlib.util
import sys
from pathlib import Path

import pytest

_SYNC = Path(__file__).resolve().parents[1] / "vroid-sync.py"


@pytest.fixture
def vs(monkeypatch):
    lib = type(sys)("lib")
    integ = type(sys)("lib.integrations")
    hub = type(sys)("lib.integrations.vroid_hub")
    hub.VRoidHub = object
    hub.VRoidHubError = Exception
    monkeypatch.setitem(sys.modules, "lib", lib)
    monkeypatch.setitem(sys.modules, "lib.integrations", integ)
    monkeypatch.setitem(sys.modules, "lib.integrations.vroid_hub", hub)
    spec = importlib.util.spec_from_file_location("vroid_sync_t", _SYNC)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    for n in mod.CREDENTIAL_NAMES:
        monkeypatch.delenv(n, raising=False)
    return mod


def test_missing_credentials_come_from_the_vault(vs, capsys):
    import os

    asked = []

    def fetch(name):
        asked.append(name)
        return f"value-of-{name}", "via test"

    assert vs.ensure_app_credentials(fetch) == list(vs.CREDENTIAL_NAMES)
    assert asked == list(vs.CREDENTIAL_NAMES)
    assert os.environ["VROID_HUB_CLIENT_ID"] == "value-of-VROID_HUB_CLIENT_ID"
    out = capsys.readouterr()
    assert "value-of" not in out.out + out.err


def test_an_environment_value_wins_and_the_vault_is_not_asked(vs, monkeypatch):
    monkeypatch.setenv("VROID_HUB_CLIENT_ID", "from-env")
    asked = []
    vs.ensure_app_credentials(lambda n: (asked.append(n), ("v", ""))[1])
    assert asked == ["VROID_HUB_CLIENT_SECRET"]
    import os

    assert os.environ["VROID_HUB_CLIENT_ID"] == "from-env"


def test_a_vault_miss_fills_nothing(vs):
    import os

    assert vs.ensure_app_credentials(lambda n: (None, "absent")) == []
    assert "VROID_HUB_CLIENT_ID" not in os.environ
