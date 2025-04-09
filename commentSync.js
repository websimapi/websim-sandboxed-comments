// Sync logic for comments with consensus algorithm
async function loadAndSyncComments(checkNewOnly = false) {
  try {
    if (!projectId) return;

    const user = await getCurrentUser();
    
    // Get all comments from API
    const response = await fetch(`/api/v1/projects/${projectId}/comments`);
    const data = await response.json();
    
    if (data.comments.data.length === 0) return;

    // Get comments from database for comparison
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

// Handle database updates when subscribed comments change
function handleDatabaseUpdates(comments) {
  console.log('Database comments updated, applying consensus rules');
  applyConsensusRules(comments);
  checkForNewGoldComments();
}

// Apply consensus rules to determine what data to render
async function applyConsensusRules(dbComments) {
  try {
    // Get API comments for comparison
    const response = await fetch(`/api/v1/projects/${projectId}/comments`);
    const data = await response.json();
    const apiComments = data.comments.data.map(item => item.comment);
    
    // Group comments by ID to compare
    const dbCommentsByIdMap = new Map();
    for (const comment of dbComments) {
      if (!dbCommentsByIdMap.has(comment.comment_id)) {
        dbCommentsByIdMap.set(comment.comment_id, []);
      }
      dbCommentsByIdMap.get(comment.comment_id).push(comment);
    }
    
    // For each unique comment ID in the database
    for (const [commentId, variants] of dbCommentsByIdMap.entries()) {
      // If there are multiple variants, apply consensus
      if (variants.length > 1) {
        // Sort by check_count (consensus votes) in descending order
        variants.sort((a, b) => (b.check_count || 0) - (a.check_count || 0));
        
        // The variant with the highest check_count wins
        const consensusVariant = variants[0];
        
        // Find the corresponding API comment
        const apiComment = apiComments.find(c => c.id === commentId);
        
        if (apiComment) {
          // Update UI based on consensus variant
          updateCommentUI(commentId, {
            ...apiComment,
            pinned: consensusVariant.pinned,
            pinned_by: { username: consensusVariant.pinned_by },
            reactions: JSON.parse(consensusVariant.reactions),
            reply_count: consensusVariant.reply_count
          });
        }
      }
    }
  } catch (err) {
    console.error('Error applying consensus rules:', err);
  }
}

// Main synchronization function with consensus check
async function syncWithConsensus() {
  try {
    console.log('Running sync with consensus check');
    
    // Get current user for permission checks
    const user = await getCurrentUser();
    
    // Get all API comments
    const apiResponse = await fetch(`/api/v1/projects/${projectId}/comments`);
    const apiData = await apiResponse.json();
    const apiComments = apiData.comments.data.map(item => item.comment);
    
    // Get all database comments
    const dbComments = await room.collection('comments').getList();
    const dbCommentMap = new Map(dbComments.map(comment => [comment.comment_id, comment]));
    
    // 1. Check for API comments that need to be added to database
    for (const comment of apiComments) {
      // If it's the user's own comment and not in database, add it
      if (comment.author.username === user.username && !dbCommentMap.has(comment.id)) {
        await syncCommentToDatabase(comment);
      } 
      // If comment is in database, check if metadata needs updating
      else if (dbCommentMap.has(comment.id) && comment.author.username === user.username) {
        const dbComment = dbCommentMap.get(comment.id);
        if (hasCommentMetadataChanged(comment, dbComment)) {
          await syncCommentToDatabase(comment, dbComment);
        }
      }
      
      // Update check count for consensus even if no changes
      if (dbCommentMap.has(comment.id) && comment.author.username === user.username) {
        const dbComment = dbCommentMap.get(comment.id);
        await room.collection('comments').update(dbComment.id, {
          last_checked: new Date().toISOString(),
          check_count: (dbComment.check_count || 0) + 1
        });
      }
    }
    
    // 2. Update UI for all comments based on database consensus
    applyConsensusRules(dbComments);
    
    // 3. Check for new gold comments
    checkForNewGoldComments();
    
    // 4. Update UI for any new comments
    await loadAndSyncComments(true);
    
  } catch (err) {
    console.error('Error in syncWithConsensus:', err);
  }
}