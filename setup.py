import setuptools

from matrix_puppeteer_line.get_version import git_tag, git_revision, version, linkified_version

with open("requirements.txt") as reqs:
    install_requires = reqs.read().splitlines()

with open("optional-requirements.txt") as reqs:
    extras_require = {}
    current = []
    for line in reqs.read().splitlines():
        if line.startswith("#/"):
            extras_require[line[2:]] = current = []
        elif not line or line.startswith("#"):
            continue
        else:
            current.append(line)

extras_require["all"] = list({dep for deps in extras_require.values() for dep in deps})

try:
    long_desc = open("README.md").read()
except IOError:
    long_desc = "Failed to read README.md"

with open("matrix_puppeteer_line/version.py", "w") as version_file:
    version_file.write(f"""# Generated in setup.py

git_tag = {git_tag!r}
git_revision = {git_revision!r}
version = {version!r}
linkified_version = {linkified_version!r}
""")

setuptools.setup(
    name="matrix-puppeteer-line",
    version=version,
    url="https://src.miscworks.net/fair/matrix-puppeteer-line",

    author="Andrew Ferrazzutti",
    author_email="fair@miscworks.net",

    description="A very hacky Matrix-LINE bridge based on running LINE's Chrome extension in Puppeteer.",
    long_description=long_desc,
    long_description_content_type="text/markdown",

    packages=setuptools.find_packages(),

    install_requires=install_requires,
    extras_require=extras_require,
    python_requires="~=3.7",

    classifiers=[
        "Development Status :: 2 - Pre-Alpha",
        "License :: OSI Approved :: GNU Affero General Public License v3 or later (AGPLv3+)",
        "Topic :: Communications :: Chat",
        "Framework :: AsyncIO",
        "Programming Language :: Python",
        "Programming Language :: Python :: 3",
        "Programming Language :: Python :: 3.7",
        "Programming Language :: Python :: 3.8",
    ],
    package_data={"matrix_puppeteer_line": [
        "example-config.yaml",
    ]},
    data_files=[
        (".", ["matrix_puppeteer_line/example-config.yaml"]),
    ],
)
