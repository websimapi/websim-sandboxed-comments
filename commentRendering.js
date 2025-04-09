function renderReactions(reactions, container) {
  container.innerHTML = reactions.map(reaction => `
    <span class="reaction">
      ${getEmoji(reaction.emoji.name)} ${reaction.count}
    </span>
  `).join('');
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

    // Detect and remove duplicates in replies
    const uniqueReplies = [];
    const seenReplies = new Set();
    
    for (const item of data.comments.data) {
      const reply = item.comment;
      // Create a unique key for each reply based on content, user, and date
      const replyKey = `${reply.raw_content}_${reply.author.username}_${reply.created_at}`;
      
      if (!seenReplies.has(replyKey)) {
        seenReplies.add(replyKey);
        uniqueReplies.push(item);
      } else {
        console.log('Detected duplicate reply, skipping:', reply.id);
      }
    }

    // Render each unique reply
    for (const [index, reply] of uniqueReplies.entries()) {
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