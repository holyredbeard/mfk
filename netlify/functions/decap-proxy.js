// Basic structure for the Decap CMS proxy function
// We will add authentication and GitHub interaction logic here.

const { Octokit } = require("@octokit/rest");
const fetch = require("node-fetch"); // Needed by Octokit in some environments

// Environment variables (set these in Netlify Build & deploy > Environment)
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const PROXY_PASSWORD = process.env.DECAP_PROXY_PASSWORD;
const GITHUB_REPO = process.env.GITHUB_REPO; // e.g., "henrik56/monsterasfk"
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || "master"; // Default to master

// --- Basic Authentication Middleware ---
function authenticate(event) {
  if (!PROXY_PASSWORD) {
    console.error("DECAP_PROXY_PASSWORD environment variable not set.");
    return { statusCode: 500, body: "Server configuration error: Missing proxy password." };
  }

  // Log incoming headers and body for debugging auth
  console.log("Auth Check - Headers:", JSON.stringify(event.headers, null, 2));
  console.log("Auth Check - Body:", event.body); // Body might be null for some requests

  const authHeader = event.headers.authorization;
  let providedPassword = null;
  if (authHeader && authHeader.startsWith("Bearer ")) {
    providedPassword = authHeader.substring(7);
    console.log("Auth Check: Found Bearer token.");
  }
  // Add checks for other potential ways Decap might send it if needed

  if (providedPassword !== PROXY_PASSWORD) {
    console.warn("Proxy authentication failed. Provided password/token does not match expected PROXY_PASSWORD.");
    // Return a JSON body for the error
    return { 
      statusCode: 401, 
      body: JSON.stringify({ message: "Unauthorized" }) 
    };
  }
  console.log("Auth Check: Successful.");
  return null; // Authentication successful
}

// --- GitHub API Client ---
const octokit = new Octokit({ auth: GITHUB_TOKEN, request: { fetch } });

// --- Main Handler ---
exports.handler = async (event, context) => {
  console.log("Decap Proxy function invoked:", event.httpMethod, event.path);

  // 1. Authentication
  const authError = authenticate(event);
  if (authError) {
    return authError;
  }

  // 2. Input Validation
  if (!GITHUB_REPO) {
    return { statusCode: 500, body: "Server configuration error: Missing GITHUB_REPO." };
  }
  const [owner, repo] = GITHUB_REPO.split('/');
  if (!owner || !repo) {
    return { statusCode: 500, body: "Server configuration error: Invalid GITHUB_REPO format (should be owner/repo)." };
  }

  // 3. Routing based on Decap CMS API path
  // Decap uses paths like /.netlify/functions/decap-proxy/content/path/to/file.json
  // We need to extract the relevant part after the function name
  const decapPathMatch = event.path.match(/\/.netlify\/functions\/decap-proxy\/(.*)/);
  const decapApiPath = decapPathMatch ? decapPathMatch[1] : null;

  console.log("Decap API Path:", decapApiPath);

  try {
    if (event.httpMethod === "GET" && decapApiPath && decapApiPath.startsWith('content/')) {
      // Handle file reading
      const filePath = decapApiPath.substring('content/'.length);
      console.log(`Attempting to read file: ${filePath}`);

      const { data } = await octokit.repos.getContent({
        owner,
        repo,
        path: filePath,
        ref: GITHUB_BRANCH,
      });

      // Content is Base64 encoded
      const content = Buffer.from(data.content, 'base64').toString('utf-8');

      return {
        statusCode: 200,
        body: content, // Return raw content
        headers: {
          // Decap expects specific headers, Content-Type might vary
          'Content-Type': 'application/json', // Adjust if reading non-JSON files
          'ETag': data.sha // Important for updates
        },
      };

    } else if (event.httpMethod === "PUT" && decapApiPath && decapApiPath.startsWith('content/')) {
      // Handle file writing/updating
      const filePath = decapApiPath.substring('content/'.length);
      console.log(`Attempting to write file: ${filePath}`);

      const requestBody = JSON.parse(event.body);
      const newContentBase64 = Buffer.from(JSON.stringify(requestBody.content, null, 2)).toString('base64'); // Assuming JSON content
      const commitMessage = requestBody.message || `Update ${filePath} via Decap CMS`;
      const currentSha = event.headers['if-match']; // Decap sends current SHA here

      if (!currentSha) {
        return { statusCode: 400, body: JSON.stringify({ message: "Missing If-Match header (file SHA)." }) };
      }

      await octokit.repos.createOrUpdateFileContents({
        owner,
        repo,
        path: filePath,
        message: commitMessage,
        content: newContentBase64,
        sha: currentSha,
        branch: GITHUB_BRANCH,
        // author/committer details can be added if needed
      });

      return {
        statusCode: 200,
        body: JSON.stringify({ message: "File updated successfully" })
      };

    } else {
      // Handle other methods/paths (e.g., /media, /git) if needed in the future
      console.warn(`Unhandled path or method: ${event.httpMethod} ${decapApiPath}`);
      return {
        statusCode: 404,
        body: JSON.stringify({ message: "Not Found or Method Not Allowed by Proxy" })
      };
    }
  } catch (error) {
    console.error("Error interacting with GitHub:", error);
    // Try to return a more specific error if possible
    if (error.status === 404) {
        return { statusCode: 404, body: JSON.stringify({ message: `File not found on GitHub: ${error.message}` }) };
    } else if (error.status === 409) {
        return { statusCode: 409, body: JSON.stringify({ message: `Conflict updating file (likely outdated SHA): ${error.message}` }) };
    }
    return {
      statusCode: 500,
      body: JSON.stringify({ message: `Internal Server Error: ${error.message}` })
    };
  }
}; 