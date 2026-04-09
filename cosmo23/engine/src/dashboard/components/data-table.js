/**
 * DataTable Component
 * Sortable and filterable table with row click handlers
 */
class DataTable {
  constructor(containerSelector, columns, data, options = {}) {
    this.container = document.querySelector(containerSelector);
    this.columns = columns; // [{ key, label, sortable, formatter, width }]
    this.data = data;
    this.options = {
      sortable: options.sortable !== false,
      filterable: options.filterable !== false,
      rowClick: options.rowClick || null,
      emptyMessage: options.emptyMessage || 'No data available'
    };
    
    this.sortColumn = null;
    this.sortDirection = 'desc';
    this.filters = {};
    this.filteredData = [...data];
    
    if (!this.container) {
      console.error(`DataTable container not found: ${containerSelector}`);
      return;
    }
    
    this.render();
  }
  
  render() {
    this.container.innerHTML = '';
    
    // Create wrapper
    const wrapper = document.createElement('div');
    wrapper.className = 'data-table-wrapper';
    
    // Create table
    const table = document.createElement('table');
    table.className = 'data-table';
    
    // Create header
    const thead = document.createElement('thead');
    const headerRow = document.createElement('tr');
    
    this.columns.forEach(col => {
      const th = document.createElement('th');
      th.textContent = col.label;
      if (col.width) {
        th.style.width = col.width;
      }
      
      if (col.sortable !== false && this.options.sortable) {
        th.classList.add('sortable');
        th.addEventListener('click', () => this.sort(col.key));
        
        // Add sort indicator
        if (this.sortColumn === col.key) {
          const indicator = document.createElement('span');
          indicator.className = 'sort-indicator';
          indicator.textContent = this.sortDirection === 'asc' ? ' ▲' : ' ▼';
          th.appendChild(indicator);
        }
      }
      
      headerRow.appendChild(th);
    });
    
    thead.appendChild(headerRow);
    table.appendChild(thead);
    
    // Create body
    const tbody = document.createElement('tbody');
    
    if (this.filteredData.length === 0) {
      const emptyRow = document.createElement('tr');
      const emptyCell = document.createElement('td');
      emptyCell.colSpan = this.columns.length;
      emptyCell.className = 'empty-message';
      emptyCell.textContent = this.options.emptyMessage;
      emptyRow.appendChild(emptyCell);
      tbody.appendChild(emptyRow);
    } else {
      this.filteredData.forEach(row => {
        const tr = document.createElement('tr');
        
        if (this.options.rowClick) {
          tr.classList.add('clickable');
          tr.addEventListener('click', () => this.options.rowClick(row));
        }
        
        this.columns.forEach(col => {
          const td = document.createElement('td');
          const value = this.getNestedValue(row, col.key);
          
          if (col.formatter) {
            const formatted = col.formatter(value, row);
            if (typeof formatted === 'string') {
              td.innerHTML = formatted;
            } else {
              td.appendChild(formatted);
            }
          } else {
            td.textContent = value !== null && value !== undefined ? value : '';
          }
          
          tr.appendChild(td);
        });
        
        tbody.appendChild(tr);
      });
    }
    
    table.appendChild(tbody);
    wrapper.appendChild(table);
    this.container.appendChild(wrapper);
  }
  
  sort(columnKey, direction = null) {
    // Toggle direction if same column
    if (this.sortColumn === columnKey && direction === null) {
      this.sortDirection = this.sortDirection === 'asc' ? 'desc' : 'asc';
    } else if (direction) {
      this.sortDirection = direction;
    } else {
      this.sortDirection = 'desc';
    }
    
    this.sortColumn = columnKey;
    
    // Sort data
    this.filteredData.sort((a, b) => {
      const valA = this.getNestedValue(a, columnKey);
      const valB = this.getNestedValue(b, columnKey);
      
      // Handle null/undefined
      if (valA === null || valA === undefined) return 1;
      if (valB === null || valB === undefined) return -1;
      
      // Compare
      let comparison = 0;
      if (typeof valA === 'number' && typeof valB === 'number') {
        comparison = valA - valB;
      } else {
        comparison = String(valA).localeCompare(String(valB));
      }
      
      return this.sortDirection === 'asc' ? comparison : -comparison;
    });
    
    this.render();
  }
  
  filter(filters) {
    this.filters = filters;
    
    // Apply filters
    this.filteredData = this.data.filter(row => {
      for (const [key, value] of Object.entries(filters)) {
        if (!value) continue; // Skip empty filters
        
        const rowValue = this.getNestedValue(row, key);
        if (rowValue === null || rowValue === undefined) return false;
        
        // String match (case insensitive)
        if (typeof value === 'string') {
          if (!String(rowValue).toLowerCase().includes(value.toLowerCase())) {
            return false;
          }
        }
        // Exact match for other types
        else if (rowValue !== value) {
          return false;
        }
      }
      return true;
    });
    
    this.render();
  }
  
  updateData(newData) {
    this.data = newData;
    this.filter(this.filters); // Reapply filters
  }
  
  getNestedValue(obj, path) {
    return path.split('.').reduce((current, prop) => {
      return current && current[prop] !== undefined ? current[prop] : null;
    }, obj);
  }
}

// Export for use in other scripts
if (typeof module !== 'undefined' && module.exports) {
  module.exports = DataTable;
}

