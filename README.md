# vibecode

`vibecode` is a minimal Claude code alternative that provides a command-line interface for interacting with an AI model via an API. It allows users to perform various file operations and shell commands.

## Features

- **File Operations**:
  - Read file with line numbers.
  - Write content to a file.
  - Replace a specified string in a file.
  - Find files by pattern, sorted by modification time.
  - Search files for a regex pattern.
  - Ask AI to review your changes.
  - Undo changes in file.

- **Shell Commands**:
  - Run shell commands.

- **Interactive CLI**:
  - Clear conversation history.
  - Quit the application.

## Installation

1. **Clone the repository**:
   ```sh
   git clone https://github.com/yourusername/vibecode.git
   cd vibecode
   ```

2. **Install dependencies**:
   ```sh
   npm install
   ```

3. **Set up the API key**:
   Ensure you have the `MISTRAL_API_KEY` environment variable set with your Mistral AI API key.

## Usage

1. **Run the script**:
   node vibecode.js
   
2. **Interact with the AI**:
   - Type your queries and press Enter.
   - Use `/clear` to clear the conversation history.
   - Use `/quit` or `exit` to quit the application.

## Commands

- `/clear`: Clear the conversation history.
- `/quit` or `exit`: Quit the application.

## Configuration

- **API Key**: Set the `MISTRAL_API_KEY` environment variable with your Mistral AI API key.

## Contributing

Contributions are welcome! Please open an issue or submit a pull request.

## License

This project is licensed under the MIT License.