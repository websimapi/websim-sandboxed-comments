// Initialize WebsimSocket for database access
const room = new WebsimSocket();
    
const REFRESH_INTERVAL = 30000; // Check for new comments every 30 seconds
const DB_CHECK_INTERVAL = 10000; // Check database for new gold comments every 10 seconds
let lastCommentTimestamp = null;
let projectId = null;
let currentUser = null;
const iframeMap = new Map();
let goldCommentIds = new Set(); // Track which comments are gold

// Add emoji conversion function 
function getEmoji(name) {
  return emojiMap[name.toLowerCase()] || name;
}

async function getCurrentUser() {
  if (!currentUser) {
    currentUser = await window.websim.getUser();
  }
  return currentUser;
}

async function formatTimestamp(timestamp) {
  const date = new Date(timestamp);
  const now = new Date();
  const diff = now - date;
  
  if (diff < 60000) return 'just now';
  if (diff < 3600000) return `${Math.floor(diff/60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff/3600000)}h ago`;
  if (diff < 604800000) return `${Math.floor(diff/86400000)}d ago`;
  
  return date.toLocaleDateString();
}

function renderReactions(reactions, container) {
  container.innerHTML = reactions.map(reaction => `
    <span class="reaction">
      ${getEmoji(reaction.emoji.name)} ${reaction.count}
    </span>
  `).join('');
}

async function loadReplies(commentId, repliesContainer) {
  try {
    // Get metadata about comment to know total replies
    const response = await fetch(`/api/v1/projects/${projectId}/comments/${commentId}`);
    const commentData = await response.json();
    const totalReplies = commentData.comment.reply_count;

    // Fetch replies with proper pagination
    const repliesResponse = await fetch(
      `/api/v1/projects/${projectId}/comments/${commentId}/replies?first=${totalReplies}`
    );
    const data = await repliesResponse.json();
    
    repliesContainer.innerHTML = ''; // Clear loading message
    
    // Get template for rendering individual replies
    const template = document.getElementById('comment-template');
    const blobUrls = [];

    // Get database comments to check gold status
    const dbComments = await room.collection('comments').getList();
    const existingCommentIds = new Set(dbComments.map(c => c.comment_id));

    // Render each reply
    for (const [index, reply] of data.comments.data.entries()) {
      const isInDatabase = existingCommentIds.has(reply.comment.id);
      const {container, blobUrl} = await renderComment(
        reply.comment,
        template,
        repliesContainer,
        `reply-${commentId}-${index}`,
        iframeMap,
        isInDatabase
      );
      blobUrls.push(blobUrl);
      repliesContainer.appendChild(container);
    }

    // Clean up blob URLs when unloading
    window.addEventListener('unload', () => {
      blobUrls.forEach(URL.revokeObjectURL);
    }, { once: true });

  } catch (err) {
    console.error('Error loading replies:', err);
    repliesContainer.innerHTML = '<div class="loading-replies">Error loading replies - please try again later</div>';
  }
}

async function renderComment(comment, template, commentsDiv, index, iframeMap, isInDatabase) {
  const container = template.content.cloneNode(true);
  
  const commentContainer = container.querySelector('.comment-container');
  commentContainer.dataset.commentId = comment.id; // Store comment ID for gold outline updates
  if (isInDatabase) {
    commentContainer.classList.add('in-database');
    goldCommentIds.add(comment.id); // Track gold comment
  }
  
  const avatar = container.querySelector('.avatar');
  const username = container.querySelector('.username');
  const timestamp = container.querySelector('.timestamp');
  const pinnedBadge = container.querySelector('.pinned-badge');
  const reactionList = container.querySelector('.reaction-list');
  const replyCount = container.querySelector('.reply-count');
  const iframe = container.querySelector('iframe');

  iframeMap.set(index, iframe);

  // Set up header info
  avatar.src = `https://images.websim.ai/avatar/${comment.author.username}`;
  username.href = `https://websim.ai/@${comment.author.username}`;
  username.textContent = '@' + comment.author.username;
  timestamp.textContent = await formatTimestamp(comment.created_at);

  // Show pinned status
  if (comment.pinned) {
    pinnedBadge.style.display = 'inline';
    if (comment.pinned_by) {
      pinnedBadge.title = `Pinned by @${comment.pinned_by.username}`;
    }
  }

  // Show reactions
  renderReactions(comment.reactions, reactionList);

  // Show reply count
  if (comment.reply_count > 0) {
    replyCount.textContent = `${comment.reply_count} ${comment.reply_count === 1 ? 'reply' : 'replies'}`;
  }

  // Create sandboxed comment content
  const html = `<!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <style>
        body { 
          margin: 0;
          font-family: system-ui, sans-serif;
          line-height: 1.5;
        }
        p { margin: 0 0 1em; }
        a { color: #0066cc; }
        img { max-width: 100%; height: auto; }
      </style>
    </head>
    <body>
      ${comment.raw_content || ''}
      <script>
        window.addEventListener('load', () => {
          const height = document.body.scrollHeight;
          window.parent.postMessage({
            type: 'resize', 
            height,
            index: ${index}
          }, '*');
        });
      <\/script>
    </body>
    </html>`;

  const blob = new Blob([html], {type: 'text/html'});
  const blobUrl = URL.createObjectURL(blob);
  iframe.src = blobUrl;
  
  // Add replies container and click handler if there are replies
  if (comment.reply_count > 0) {
    const replyCountElement = container.querySelector('.reply-count');
    const repliesTemplate = document.getElementById('replies-template');
    const repliesContainer = repliesTemplate.content.cloneNode(true).querySelector('.replies-container');
    
    container.appendChild(repliesContainer);

    let repliesLoaded = false;
    replyCountElement.addEventListener('click', async () => {
      repliesContainer.classList.toggle('expanded');
      
      // Load replies first time container is expanded
      if (!repliesLoaded) {
        await loadReplies(comment.id, repliesContainer);
        repliesLoaded = true;
      }
    });
  }
  
  return {container, blobUrl};
}

// Function to create or update a comment in the database
async function syncCommentToDatabase(comment, existingDbComment = null) {
  try {
    // If we have an existing DB comment, update it
    if (existingDbComment) {
      // Only update if something has changed
      if (hasCommentMetadataChanged(comment, existingDbComment)) {
        await room.collection('comments').update(existingDbComment.id, {
          comment_id: comment.id,
          project_id: comment.project_id,
          content: comment.raw_content,
          parent_comment_id: comment.parent_comment_id,
          pinned: comment.pinned,
          pinned_by: comment.pinned_by?.username,
          reactions: JSON.stringify(comment.reactions),
          reply_count: comment.reply_count,
          created_at: comment.created_at
        });
        console.log('Updated existing comment in database:', comment.id);
        return true;
      }
      return false; // No changes needed
    }
    
    // Otherwise, check if this is a duplicate before creating
    const existingComments = await room.collection('comments').getList();
    
    // Check for duplicates using multiple criteria
    const isDuplicate = existingComments.some(dbComment => {
      return (
        dbComment.comment_id === comment.id || // Check by comment ID
        (dbComment.created_at === comment.created_at && // Check by timestamp AND content
         dbComment.content === comment.raw_content)
      );
    });

    if (isDuplicate) {
      console.log('Comment already exists in database, skipping sync:', comment.id);
      return false;
    }

    // Only if we're absolutely sure it's not a duplicate, create the record
    const newRecord = await room.collection('comments').create({
      comment_id: comment.id,
      project_id: comment.project_id,
      content: comment.raw_content,
      parent_comment_id: comment.parent_comment_id,
      pinned: comment.pinned,
      pinned_by: comment.pinned_by?.username,
      reactions: JSON.stringify(comment.reactions),
      reply_count: comment.reply_count,
      created_at: comment.created_at
    });
    
    console.log('Successfully synced new comment to database:', comment.id);
    
    // Update goldCommentIds immediately after successful insert
    goldCommentIds.add(comment.id);
    
    return true;
  } catch (err) {
    console.error('Error syncing comment to database:', err);
    return false;
  }
}

// Compare comment API data with database record to check for metadata changes
function hasCommentMetadataChanged(apiComment, dbComment) {
  let apiReactions;
  let dbReactions;
  
  try {
    apiReactions = JSON.stringify(apiComment.reactions);
    dbReactions = dbComment.reactions; // Already stringified in DB
  } catch (e) {
    console.error('Error comparing reactions:', e);
    // If there's an error parsing, assume they're different
    return true;
  }
  
  return (
    apiComment.pinned !== dbComment.pinned ||
    apiComment.pinned_by?.username !== dbComment.pinned_by ||
    apiComment.reply_count !== dbComment.reply_count ||
    apiReactions !== dbReactions
  );
}

// Update UI for a comment that has metadata changes
function updateCommentUI(commentId, apiComment) {
  const commentContainer = document.querySelector(`.comment-container[data-comment-id="${commentId}"]`);
  if (!commentContainer) return;
  
  // Update pinned status
  const pinnedBadge = commentContainer.querySelector('.pinned-badge');
  if (pinnedBadge) {
    pinnedBadge.style.display = apiComment.pinned ? 'inline' : 'none';
    if (apiComment.pinned && apiComment.pinned_by) {
      pinnedBadge.title = `Pinned by @${apiComment.pinned_by.username}`;
    }
  }
  
  // Update reactions
  const reactionList = commentContainer.querySelector('.reaction-list');
  if (reactionList) {
    renderReactions(apiComment.reactions, reactionList);
  }
  
  // Update reply count
  const replyCount = commentContainer.querySelector('.reply-count');
  if (replyCount) {
    if (apiComment.reply_count > 0) {
      replyCount.textContent = `${apiComment.reply_count} ${apiComment.reply_count === 1 ? 'reply' : 'replies'}`;
    } else {
      replyCount.textContent = '';
    }
  }
  
  // If comment becomes pinned and isn't already at the top, move it to top
  if (apiComment.pinned) {
    const commentsDiv = document.getElementById('comments');
    const firstComment = commentsDiv.firstChild;
    
    // If this isn't already the first comment, move it to top
    if (firstComment !== commentContainer) {
      commentsDiv.insertBefore(commentContainer, firstComment);
    }
  }
}

async function loadAndSyncComments(checkNewOnly = false) {
  try {
    if (!projectId) {
      projectId = (await window.websim.getCurrentProject()).id;
    }

    const user = await getCurrentUser();
    
    // Get all comments from API
    const response = await fetch(`/api/v1/projects/${projectId}/comments`);
    const data = await response.json();
    
    if (data.comments.data.length === 0) return;

    // Get ALL comments from database first 
    const dbComments = await room.collection('comments').getList();
    const dbCommentMap = new Map(dbComments.map(comment => [comment.comment_id, comment]));

    const latestTimestamp = new Date(data.comments.data[0].comment.created_at);
    
    if (checkNewOnly && (!lastCommentTimestamp || latestTimestamp <= lastCommentTimestamp)) {
      // Even if no new comments, still sync metadata changes
      await syncExistingCommentsMetadata(data.comments.data, dbCommentMap, user);
      return;
    }
    
    if (!checkNewOnly) {
      document.getElementById('comments').innerHTML = '';
    }

    const commentsDiv = document.getElementById('comments');
    const template = document.getElementById('comment-template');
    const blobUrls = [];

    // Process comments in reverse order when checking new only
    let commentsToProcess = checkNewOnly ? 
      data.comments.data.filter(({comment}) => 
        !lastCommentTimestamp || new Date(comment.created_at) > lastCommentTimestamp
      ).reverse() : 
      data.comments.data;

    // Sort comments - pinned first, then by date
    commentsToProcess = commentsToProcess.sort((a, b) => {
      // If both are pinned or both not pinned, sort by date
      if (a.comment.pinned === b.comment.pinned) {
        return new Date(b.comment.created_at) - new Date(a.comment.created_at);
      }
      // If one is pinned, it should come first
      return b.comment.pinned ? 1 : -1;
    });

    // Render comments
    for (const [index, {comment}] of commentsToProcess.entries()) {
      // Add gold outline check before rendering
      const isInDatabase = dbCommentMap.has(comment.id);
      const {container, blobUrl} = await renderComment(
        comment, 
        template, 
        commentsDiv, 
        index, 
        iframeMap, 
        isInDatabase
      );
      blobUrls.push(blobUrl);
      
      // After rendering, if it's the current user's comment and not already in database, sync it
      if (comment.author.username === user.username && !isInDatabase) {
        await syncCommentToDatabase(comment);
      } else if (isInDatabase) {
        // If it's already in database, check for metadata changes
        const dbComment = dbCommentMap.get(comment.id);
        if (hasCommentMetadataChanged(comment, dbComment)) {
          await syncCommentToDatabase(comment, dbComment);
          // Update UI since metadata changed
          updateCommentUI(comment.id, comment);
        }
      }
      
      if (checkNewOnly) {
        const firstChild = container.firstElementChild;
        firstChild.classList.add('new-comment');
        // If pinned, insert at top, otherwise at normal position
        if (comment.pinned) {
          // Find the first non-pinned comment to insert before
          const firstNonPinned = Array.from(commentsDiv.children).find(
            child => !child.querySelector('.pinned-badge').style.display === 'inline'
          );
          if (firstNonPinned) {
            commentsDiv.insertBefore(container, firstNonPinned);
          } else {
            commentsDiv.appendChild(container);
          }
        } else {
          commentsDiv.appendChild(container);
        }
        
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            firstChild.classList.remove('new-comment');
          });
        });
      } else {
        commentsDiv.appendChild(container);
      }
    }

    lastCommentTimestamp = latestTimestamp;

    // Clean up blob URLs
    window.addEventListener('unload', () => {
      blobUrls.forEach(URL.revokeObjectURL);
    }, { once: true });
    
    // After rendering new comments, also check for metadata changes on existing comments
    if (checkNewOnly) {
      await syncExistingCommentsMetadata(data.comments.data, dbCommentMap, user);
    }
    
  } catch (err) {
    console.error('Error in loadAndSyncComments:', err);
  }
}

// Sync metadata changes for existing comments
async function syncExistingCommentsMetadata(apiComments, dbCommentMap, user) {
  // For each API comment that already exists in database
  for (const {comment} of apiComments) {
    if (dbCommentMap.has(comment.id)) {
      const dbComment = dbCommentMap.get(comment.id);
      
      // Check if metadata needs updating
      if (hasCommentMetadataChanged(comment, dbComment)) {
        // Only the comment owner can update their own comment in database
        if (comment.author.username === user.username) {
          await syncCommentToDatabase(comment, dbComment);
        }
        
        // Update UI regardless of whether database was updated
        updateCommentUI(comment.id, comment);
      }
    }
  }
}

// Comprehensive check for new gold comments and metadata updates
async function checkForNewGoldComments() {
  try {
    if (!projectId) return;
    
    // Get latest database comments
    const dbComments = await room.collection('comments').getList();
    const dbCommentMap = new Map(dbComments.map(comment => [comment.comment_id, comment]));
    
    // Get latest API comments for metadata comparison
    const response = await fetch(`/api/v1/projects/${projectId}/comments`);
    const data = await response.json();
    const apiCommentMap = new Map(data.comments.data.map(item => [item.comment.id, item.comment]));
    
    // Get all comment containers from the page
    const commentContainers = document.querySelectorAll('.comment-container');
    
    // Check each rendered comment
    commentContainers.forEach(container => {
      const commentId = container.dataset.commentId;
      
      // If comment is in database but doesn't have gold outline, add it
      if (dbCommentMap.has(commentId) && !container.classList.contains('in-database')) {
        // Add gold outline with a nice transition
        container.style.transition = 'border-color 0.5s ease-in-out, box-shadow 0.5s ease-in-out';
        container.classList.add('in-database');
        // Update our tracking set
        goldCommentIds.add(commentId);
      }
      
      // If comment exists in both API and database, check for metadata changes
      if (apiCommentMap.has(commentId) && dbCommentMap.has(commentId)) {
        const apiComment = apiCommentMap.get(commentId);
        const dbComment = dbCommentMap.get(commentId);
        
        // If metadata has changed, update UI (database sync happens elsewhere)
        if (hasCommentMetadataChanged(apiComment, dbComment)) {
          updateCommentUI(commentId, apiComment);
        }
      }
    });
    
  } catch (err) {
    console.error('Error checking for new gold comments:', err);
  }
}

// Initial load
loadAndSyncComments();

// Set up periodic checking for new comments and metadata updates
setInterval(() => {
  loadAndSyncComments(true);
}, REFRESH_INTERVAL);

// Set up periodic checking for new gold comments
setInterval(checkForNewGoldComments, DB_CHECK_INTERVAL);

// Subscribe to database changes
room.collection('comments').subscribe(function(comments) {
  console.log('Database comments updated:', comments);
  // When database changes, run gold comment check immediately
  checkForNewGoldComments();
});

// Listen for iframe resize messages
window.addEventListener('message', (e) => {
  if (e.data?.type === 'resize') {
    const iframe = iframeMap.get(e.data.index);
    if (iframe) {
      iframe.style.height = e.data.height + 'px';
    }
  }
});