/**
 * Turns the error from `server.listen()` into a message that says what is wrong and what to do.
 * Without this the server used to print "running" and exit silently when the port could not be used.
 */
export function listenErrorMessage(error: NodeJS.ErrnoException, host: string, port: number): string {
  const where = `${host}:${port}`;
  switch (error.code) {
    case 'EADDRINUSE':
      return `Could not start the UI: port ${port} is already in use. Another copy of the UI may still be running in another terminal window (close it), or choose a different port with PR_REVIEW_UI_PORT in .env.`;
    case 'EACCES':
      return (
        `Could not start the UI: Windows does not allow listening on ${where}. Windows reserves some port ranges ` +
        '(for Hyper-V, WSL and Docker) and the ranges change after a restart. See them with: ' +
        'netsh int ipv4 show excludedportrange protocol=tcp - then set PR_REVIEW_UI_PORT in .env to a port outside every range (for example 4700).'
      );
    case 'EADDRNOTAVAIL':
      return `Could not start the UI: this computer has no address ${host}. Check PR_REVIEW_UI_HOST in .env (leave it unset to use 127.0.0.1).`;
    default:
      return `Could not start the UI on ${where}: ${error.message}`;
  }
}
