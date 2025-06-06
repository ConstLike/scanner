# Scanner

**Scanner** is a versatile tool for analyzing source code across multiple programming languages. It recursively scans a specified directory, identifies files based on their extensions, and extracts meaningful constructs such as functions, variables, classes, and more. The extracted information is compiled into a JSON index, facilitating easy navigation and understanding of the codebase.

## Features

- **Multi-Language Support**: Currently supports TypeScript, JavaScript, and Fortran, with a modular design for adding more languages.
- **Auto-Detection**: Automatically detects which languages are present in the project.
- **Incremental Updates**: Efficiently updates the index for specific files without re-scanning the entire project.
- **Ignore Patterns**: Respects `.gitignore` and `.ignore` files, and allows additional ignore patterns.
- **Extensible**: Easy to add support for new languages by implementing the `LanguageScanner` interface.

## Installation

To use Scanner, you need to have Node.js installed. Clone the repository and install the dependencies:

```bash
git clone https://github.com/yourusername/scanner.git
cd scanner
npm install
```

## Usage

Run the scanner using `npx ts-node scanner.ts` with the following options:

- `[rootDir]`: The root directory to scan (defaults to the current working directory).
- `--root <path>`: Explicitly specify the project root.
- `--lang <list>`: Comma-separated list of languages to scan (e.g., "typescript,fortran"). Use "auto" for auto-detection.
- `--detect`: Enable auto-detection of languages.
- `--update <file>`: Specify files to update incrementally (can be repeated for multiple files).

### Examples

- **Full scan with auto-detection**:
  ```bash
  npx ts-node scanner.ts --detect
  ```
- **Scan specific languages**:
  ```bash
  npx ts-node scanner.ts --lang typescript,fortran
  ```
- **Incremental update for specific files**:
  ```bash
  npx ts-node scanner.ts --update path/to/file.ts --update path/to/another/file.f90
  ```

## Configuration

Scanner can be configured through command-line options or by modifying the code. Key configurations include:

- **Ignore Files**: By default, respects `.gitignore` and `.ignore`. Additional patterns can be specified in the code (e.g., `dist/`, `node_modules/`).
- **Extensions**: Each language scanner defines its supported extensions.

## Supported Languages

- **TypeScript/JavaScript**: Extensions `.ts`, `.tsx`, `.js`, `.jsx`
- **Fortran**: Extensions `.f`, `.for`, `.f90`, `.f95`, `.f03`, `.f08`, `.fpp`, `.F`, `.FOR`, `.F90`, `.F95`, `.F03`, `.F08`, `.FPP`

## Extending the Scanner

To add support for a new language:

1. Create a new class implementing the `LanguageScanner` interface in `language/`.
2. Define the `supportedExtensions` method to return the file extensions for the language.
3. Implement the `extractTags` method to parse the file and extract relevant tags.
4. Register the new scanner in `language/index.ts` by adding it to the `ALL_SCANNERS` object.

## Output Format

The scanner generates a `scoping-tags.json` file in the root directory, containing an array of `ScopedFileContext` objects. Each object includes:

- `filePath`: Absolute path to the file.
- `language`: The language of the file (e.g., "typescript", "fortran").
- `tags`: An array of `ExtractedTag` objects, each with:
  - `kind`: Type of construct (e.g., "function", "class", "program").
  - `name`: Name of the construct.
  - `startLine`: Starting line number (1-based).
  - `endLine`: Ending line number (1-based).
  - `code`: Source code snippet of the construct.

## License

This project is open-source and licensed under the [MIT License](LICENSE).

## Author and Contact

- **Author**: Konstantin Komarov
- **Email**: constlike@gmail.com

## Contributing

Contributions are welcome! Please submit pull requests or open issues on the GitHub repository.

## Acknowledgments

- [Babel](https://babeljs.io/) for parsing TypeScript and JavaScript.
- [ignore](https://www.npmjs.com/package/ignore) for handling ignore patterns.
