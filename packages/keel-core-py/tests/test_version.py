from keel_core import __version__


def test_version_is_exposed():
    assert __version__ == "0.1.0"
