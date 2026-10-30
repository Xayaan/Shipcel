const button = document.querySelector('#call');
const answer = document.querySelector('#answer');

button.addEventListener('click', async () => {
  button.disabled = true;
  answer.textContent = 'Calling /api/hello…';
  try {
    const response = await fetch('/api/hello');
    answer.textContent = JSON.stringify(await response.json(), null, 2);
  } catch (error) {
    answer.textContent = `The API didn't answer: ${error.message}`;
  } finally {
    button.disabled = false;
  }
});
