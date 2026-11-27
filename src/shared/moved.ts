// An old address: go to the one talk page, keeping the part after # (a talk-code link), which
// is never sent to any server.
window.location.replace(`${import.meta.env.BASE_URL}${window.location.hash}`);
