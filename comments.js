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

async function syncCommentToDatabase(comment) {
  try {
    // Get ALL existing comments first and do a thorough duplicate check
    const existingComments = await room.collection('comments').getList();
    
    // Check for duplicates using multiple criteria to be extra safe
    const duplicates = existingComments.filter(dbComment => {
      return (
        (dbComment.comment_id === comment.id) || // Check by comment ID
        (dbComment.created_at === comment.created_at && // Check by timestamp AND content
         dbComment.content === comment.raw_content)
      );
    });

    // If we found any duplicates, delete all but one
    if (duplicates.length > 0) {
      console.log(`Found ${duplicates.length} duplicate entries for comment ID: ${comment.id}`);
      
      // Keep the oldest entry (first created)
      const sortedDuplicates = [...duplicates].sort((a, b) => 
        new Date(a.created_at) - new Date(b.created_at)
      );
      
      // Keep first entry, delete the rest
      for (let i = 1; i < sortedDuplicates.length; i++) {
        try {
          // Only delete if it's the current user's comment (permission check)
          const user = await getCurrentUser();
          if (sortedDuplicates[i].username === user.username) {
            console.log(`Deleting duplicate entry: ${sortedDuplicates[i].id}`);
            await room.collection('comments').delete(sortedDuplicates[i].id);
          }
        } catch (deleteErr) {
          console.error('Error deleting duplicate:', deleteErr);
        }
      }
      
      // Since we already have this comment in the database, don't add it again
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
    const existingCommentIds = new Set(dbComments.map(c => c.comment_id));

    const latestTimestamp = new Date(data.comments.data[0].comment.created_at);
    
    if (checkNewOnly && (!lastCommentTimestamp || latestTimestamp <= lastCommentTimestamp)) {
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
      const isInDatabase = existingCommentIds.has(comment.id);
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
        const syncSuccess = await syncCommentToDatabase(comment);
        if (syncSuccess) {
          // Update gold status immediately if sync was successful
          const commentElement = container.querySelector('.comment-container');
          commentElement.classList.add('in-database');
        }
      }
      
      if (checkNewOnly) {
        const firstChild = container.firstElementChild;
        firstChild.classList.add('new-comment');
        // If pinned, insert at top, otherwise at normal position
        if (comment.pinned) {
          // Find the first non-pinned comment to insert before
          const firstNonPinned = Array.from(commentsDiv.children).find(
            child => child.querySelector('.pinned-badge').style.display === 'none'
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
    
  } catch (err) {
    console.error('Error in loadAndSyncComments:', err);
  }
}

async function checkForNewGoldComments() {
  try {
    // Get the current project ID if needed
    if (!projectId) {
      projectId = (await window.websim.getCurrentProject()).id;
    }
    
    // Get latest API comments to make sure our view is in sync
    const apiResponse = await fetch(`/api/v1/projects/${projectId}/comments`);
    const apiData = await apiResponse.json();
    const apiComments = apiData.comments.data.map(item => item.comment);
    const apiCommentIds = new Set(apiComments.map(c => c.id));
    
    // Get latest database comments
    const dbComments = await room.collection('comments').getList();
    
    // Check for and clean up any duplicates in the database
    const commentIdMap = new Map();
    const duplicatesToRemove = [];
    
    // Find duplicates
    dbComments.forEach(comment => {
      if (!commentIdMap.has(comment.comment_id)) {
        commentIdMap.set(comment.comment_id, [comment]);
      } else {
        commentIdMap.get(comment.comment_id).push(comment);
      }
    });
    
    // Process duplicates: keep oldest one, mark others for deletion
    for (const [commentId, entries] of commentIdMap.entries()) {
      if (entries.length > 1) {
        console.log(`Found ${entries.length} duplicates for comment ID: ${commentId}`);
        // Sort by created_at to keep the oldest one
        const sorted = [...entries].sort((a, b) => 
          new Date(a.created_at) - new Date(b.created_at)
        );
        
        // Keep first entry, mark others for deletion
        for (let i = 1; i < sorted.length; i++) {
          duplicatesToRemove.push(sorted[i]);
        }
      }
    }
    
    // Delete duplicates if user has permission
    const user = await getCurrentUser();
    for (const duplicate of duplicatesToRemove) {
      if (duplicate.username === user.username) {
        try {
          console.log(`Auto-deleting duplicate entry: ${duplicate.id}`);
          await room.collection('comments').delete(duplicate.id);
        } catch (err) {
          console.error('Error deleting duplicate during check:', err);
        }
      }
    }
    
    // Update with fresh comments list after cleaning up
    const updatedDbComments = await room.collection('comments').getList();
    const newGoldCommentIds = new Set(updatedDbComments.map(c => c.comment_id));

    // Get all comment containers from the page
    const commentContainers = document.querySelectorAll('.comment-container');
    const displayedCommentIds = new Set();
    
    commentContainers.forEach(container => {
      const commentId = container.dataset.commentId;
      displayedCommentIds.add(commentId);
      
      // If comment is in database but doesn't have gold outline
      if (newGoldCommentIds.has(commentId) && !container.classList.contains('in-database')) {
        // Add gold outline with a nice transition
        container.style.transition = 'border-color 0.5s ease-in-out, box-shadow 0.5s ease-in-out';
        container.classList.add('in-database');
        // Update our tracking set
        goldCommentIds.add(commentId);
      }
      
      // If comment is not in API anymore, fade it out and remove
      if (!apiCommentIds.has(commentId)) {
        container.style.transition = 'opacity 0.5s ease-in-out, transform 0.5s ease-in-out';
        container.style.opacity = '0';
        container.style.transform = 'translateY(-20px)';
        setTimeout(() => container.remove(), 500);
      }
    });
    
    // Check for API comments not displayed and add them
    const newApiComments = apiComments.filter(comment => !displayedCommentIds.has(comment.id));
    if (newApiComments.length > 0) {
      console.log(`Found ${newApiComments.length} new comments from API that aren't displayed yet`);
      loadAndSyncComments(true);
    }

    // Update the goldCommentIds set to match database state
    goldCommentIds = newGoldCommentIds;
    
  } catch (err) {
    console.error('Error checking for new gold comments:', err);
  }
}

// Initial load
loadAndSyncComments();

// Set up periodic checking for new comments
setInterval(() => {
  loadAndSyncComments(true);
}, REFRESH_INTERVAL);

// Increase frequency of checking for new gold comments and metadata sync
setInterval(checkForNewGoldComments, DB_CHECK_INTERVAL);

// Subscribe to database changes to trigger immediate UI updates
room.collection('comments').subscribe(function(comments) {
  console.log('Database comments updated, checking gold status...');
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